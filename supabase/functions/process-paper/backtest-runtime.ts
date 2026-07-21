import type { SupabaseClient } from "@supabase/supabase-js";
import { infoRequest } from "../_shared/hyperliquid.ts";
import { scalePerpFeeRate, selectFeeRate } from "../_shared/paper/fees.ts";
import { fetchPaperFunding } from "../_shared/paper/market-data.ts";
import type { PaperCommandDependencies } from "../paper-command/handler.ts";
import { buildSharedCapitalPortfolio, runDualRsiBacktest, type BacktestTrade } from "../_shared/strategies/backtest.ts";
import type { DualRsiParameters, StrategyCandle, StrategyInterval } from "../_shared/strategies/types.ts";

const WIDTH: Record<StrategyInterval, number> = { "5m": 300_000, "1h": 3_600_000 };

function normalize(asset: string, interval: StrategyInterval, payload: unknown, end: number): StrategyCandle[] {
  if (!Array.isArray(payload)) throw new Error("malformed backtest candles");
  const width = WIDTH[interval];
  return payload.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const openTime = Number(row.t);
    if (!Number.isSafeInteger(openTime) || openTime + width > end || ![row.o,row.h,row.l,row.c,row.v].every((value) => typeof value === "string")) return [];
    return [{ asset, interval, openTime, closeTime: openTime + width, open: String(row.o), high: String(row.h), low: String(row.l), close: String(row.c), volume: String(row.v), completed: true, sourceVersion: `${asset}:${interval}:${openTime}:${String(row.T ?? "")}` }];
  }).sort((left, right) => left.openTime - right.openTime);
}

async function sha256(value: unknown) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storedCandle(row: Record<string, unknown>): StrategyCandle {
  return { asset: String(row.asset), interval: row.interval as StrategyInterval,
    openTime: Date.parse(String(row.open_time)), closeTime: Date.parse(String(row.close_time)),
    open: String(row.open), high: String(row.high), low: String(row.low), close: String(row.close),
    volume: String(row.volume), completed: true, sourceVersion: String(row.source_version) };
}

async function storedCandles(service: SupabaseClient, asset: string, interval: StrategyInterval, start: number, end: number) {
  const rows: StrategyCandle[] = [];
  for (let offset = 0;; offset += 1000) {
    const { data, error } = await service.from("strategy_candles").select("*").eq("asset", asset).eq("interval", interval)
      .gte("open_time", new Date(start).toISOString()).lt("open_time", new Date(end).toISOString())
      .order("open_time").range(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []).map(storedCandle));
    if ((data?.length ?? 0) < 1000) return rows;
  }
}

async function candles(service: SupabaseClient, asset: string, interval: StrategyInterval, requestedStart: number, end: number) {
  const warmup = interval === "1h" ? 120 * WIDTH[interval] : 120 * WIDTH["1h"];
  const start = requestedStart - warmup;
  const persisted = await storedCandles(service, asset, interval, start, end);
  let fetched: StrategyCandle[] = [];
  try {
    const payload = await infoRequest({ type: "candleSnapshot", req: { coin: asset, interval, startTime: start, endTime: end } });
    fetched = normalize(asset, interval, payload, end);
  } catch (error) {
    if (!persisted.length) throw error;
  }
  return [...new Map([...persisted, ...fetched].map((candle) => [candle.openTime, candle])).values()]
    .sort((left, right) => left.openTime - right.openTime);
}

async function candleVersion(candles: StrategyCandle[]) {
  return { count: candles.length, first: candles[0]?.sourceVersion ?? null, last: candles.at(-1)?.sourceVersion ?? null,
    hash: await sha256(candles.map((candle) => [candle.openTime,candle.open,candle.high,candle.low,candle.close,candle.volume,candle.sourceVersion])) };
}

export function createBacktestRuntime(service: SupabaseClient, paper: PaperCommandDependencies) {
  return async function processBacktestChunk() {
    const { data: run, error: runError } = await service.from("backtest_runs").select("*")
      .in("status", ["queued", "running"]).order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (runError) throw new Error(runError.message);
    if (!run) return { processed: 0, completed: 0 };
    const cursor = (run.work_cursor ?? {}) as { completedAssets?: string[]; results?: Record<string, unknown> };
    const completedAssets = cursor.completedAssets ?? [];
    const asset = (run.assets as string[]).find((candidate) => !completedAssets.includes(candidate));
    if (!asset) return { processed: 0, completed: 0 };
    const { error: startError } = await service.from("backtest_runs").update({ status: "running", started_at: run.started_at ?? new Date().toISOString() }).eq("id", run.id);
    if (startError) throw new Error(startError.message);
    try {
      const requestedStart = Date.parse(run.requested_start);
      const requestedEnd = Date.parse(run.requested_end);
      const [fiveMinuteCandles, oneHourCandles, fundingInput, metadata, feeInput] = await Promise.all([
        candles(service, asset, "5m", requestedStart, requestedEnd), candles(service, asset, "1h", requestedStart, requestedEnd),
        fetchPaperFunding(asset, requestedStart, requestedEnd), paper.loadAsset(asset), paper.loadFeeSchedule(),
      ]);
      if (!metadata) throw new Error(`asset metadata unavailable for ${asset}`);
      const feeRate = scalePerpFeeRate(selectFeeRate(feeInput.schedule, "0", "0", "taker"), metadata, "taker");
      const parameters = await service.from("strategy_revisions").select("parameters").eq("id", run.revision_id).single();
      if (parameters.error || !parameters.data) throw new Error(parameters.error?.message ?? "strategy revision unavailable");
      const strategyParameters = parameters.data.parameters as DualRsiParameters;
      const allocation = String(strategyParameters.marginAllocationPct ?? "10");
      const result = runDualRsiBacktest({ asset, fiveMinuteCandles, oneHourCandles, initialCapital: String(run.initial_capital),
        marginAllocationPct: allocation, maxLeverage: metadata.maxLeverage, marginTiers: metadata.marginTiers,
        takerFeeRate: feeRate, slippageBps: "2", tradableStartMs: requestedStart,
        parameters: strategyParameters,
        fundingByTimestamp: fundingInput.points.map((point) => ({ timestampMs: point.timestampMs, rate: point.fundingRate })) });
      const warmupIndex = strategyParameters.rsiPeriod + strategyParameters.baselineLength;
      const warmupStart = fiveMinuteCandles[warmupIndex] && oneHourCandles[warmupIndex]
        ? Math.max(requestedStart, fiveMinuteCandles[warmupIndex].closeTime, oneHourCandles[warmupIndex].closeTime)
        : null;
      const [fiveMinuteVersion, oneHourVersion] = await Promise.all([candleVersion(fiveMinuteCandles), candleVersion(oneHourCandles)]);
      const storedResult = { ...result, actualTradableStart: warmupStart, inputVersions: {
        fiveMinute: fiveMinuteVersion, oneHour: oneHourVersion, funding: fundingInput.inputVersion,
      } };
      const tradeRows = result.trades.map((trade) => ({ run_id: run.id, scope: "asset", asset: trade.asset, side: trade.side,
        entry_time: new Date(trade.entryTime).toISOString(), entry_price: trade.entryPrice,
        exit_time: new Date(trade.exitTime).toISOString(), exit_price: trade.exitPrice,
        initial_margin: trade.initialMargin, gross_pnl: trade.grossPnl, fees: trade.fees, funding: trade.funding,
        net_pnl: trade.netPnl, exit_reason: trade.exitReason, fidelity: result.fidelity }));
      if (tradeRows.length) {
        const { error } = await service.from("backtest_trades").upsert(tradeRows, { onConflict: "run_id,scope,asset,side,entry_time,exit_time" });
        if (error) throw new Error(error.message);
      }
      const nextCompleted = [...completedAssets, asset];
      const nextResults = { ...(cursor.results ?? {}), [asset]: storedResult };
      const done = nextCompleted.length === (run.assets as string[]).length;
      const storedResults = Object.values(nextResults) as Array<{ trades: BacktestTrade[]; actualTradableStart: number | null; coverage: { fiveMinute: { start: number | null; end: number | null } }; metrics: unknown; fidelity: unknown; inputVersions: unknown }>;
      const starts = storedResults.map((item) => item.actualTradableStart).filter((value): value is number => value !== null);
      const ends = storedResults.map((item) => item.coverage.fiveMinute.end).filter((value): value is number => value !== null);
      const update: Record<string, unknown> = { work_cursor: { completedAssets: nextCompleted, results: nextResults },
        progress: Math.floor(nextCompleted.length / (run.assets as string[]).length * 100),
        actual_start: starts.length ? new Date(Math.max(...starts)).toISOString() : null,
        actual_end: ends.length ? new Date(Math.min(requestedEnd, ...ends)).toISOString() : null };
      if (done) {
        const portfolio = buildSharedCapitalPortfolio(String(run.initial_capital), allocation, storedResults.flatMap((item) => item.trades));
        const portfolioTradeRows = portfolio.trades.map((trade) => ({ run_id: run.id, scope: "portfolio", asset: trade.asset, side: trade.side,
          entry_time: new Date(trade.entryTime).toISOString(), entry_price: trade.entryPrice,
          exit_time: new Date(trade.exitTime).toISOString(), exit_price: trade.exitPrice,
          initial_margin: trade.initialMargin, gross_pnl: trade.grossPnl, fees: trade.fees, funding: trade.funding,
          net_pnl: trade.netPnl, exit_reason: trade.exitReason, fidelity: { execution: "bar_conservative", capital: "shared" } }));
        if (portfolioTradeRows.length) {
          const { error } = await service.from("backtest_trades").upsert(portfolioTradeRows, { onConflict: "run_id,scope,asset,side,entry_time,exit_time" });
          if (error) throw new Error(error.message);
        }
        const equityRows = portfolio.equityTimeline.map((point) => ({ run_id: run.id, sampled_at: new Date(point.sampledAt).toISOString(), equity: point.equity, reason: point.reason }));
        if (equityRows.length) {
          const { error } = await service.from("backtest_equity_points").upsert(equityRows, { onConflict: "run_id,sampled_at,reason" });
          if (error) throw new Error(error.message);
        }
        const metrics = {
        perAsset: Object.fromEntries(storedResults.map((item, index) => [(run.assets as string[])[index], item.metrics])),
        portfolio: portfolio.metrics,
        };
        const assumptions = { entry: "next_bar", collision: "adverse_first", liquidation: "precedence", slippageBps: "2", funding: "published_history", constraints: "current", portfolioCapital: "shared_available_margin" };
        Object.assign(update, { status: "completed", finished_at: new Date().toISOString(), metrics, assumptions,
          result_hash: await sha256({ revisionId: run.revision_id, assets: run.assets, inputVersions: storedResults.map((item) => item.inputVersions), assumptions, metrics }) });
      }
      const { error: updateError } = await service.from("backtest_runs").update(update).eq("id", run.id);
      if (updateError) throw new Error(updateError.message);
      return { processed: 1, completed: done ? 1 : 0, runId: run.id, asset };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { error: failureError } = await service.from("backtest_runs").update({ status: "failed", failure_reason: message, finished_at: new Date().toISOString() }).eq("id", run.id);
      if (failureError) throw new Error(`${message}; failed to persist backtest failure: ${failureError.message}`);
      return { processed: 1, completed: 0, failed: 1, runId: run.id, asset, error: message };
    }
  };
}
