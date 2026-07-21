import type { SupabaseClient } from "@supabase/supabase-js";
import { infoRequest } from "../_shared/hyperliquid.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
import { scalePerpFeeRate, selectFeeRate } from "../_shared/paper/fees.ts";
import type { PaperCommandDependencies } from "../paper-command/handler.ts";
import { runDualRsiBacktest, type BacktestTrade } from "../_shared/strategies/backtest.ts";
import { calculateBacktestMetrics } from "../_shared/strategies/metrics.ts";
import type { StrategyCandle, StrategyInterval } from "../_shared/strategies/types.ts";

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

async function candles(asset: string, interval: StrategyInterval, requestedStart: number, end: number) {
  const warmup = interval === "1h" ? 120 * WIDTH[interval] : 120 * WIDTH["1h"];
  const payload = await infoRequest({ type: "candleSnapshot", req: { coin: asset, interval, startTime: requestedStart - warmup, endTime: end } });
  return normalize(asset, interval, payload, end);
}

function portfolioMetrics(initialCapital: string, results: Array<{ trades: BacktestTrade[] }>) {
  const trades = results.flatMap((result) => result.trades).sort((left, right) => left.exitTime - right.exitTime);
  let equity = decimal(initialCapital);
  const points = [decimalString(equity)];
  for (const trade of trades) { equity = equity.plus(trade.netPnl); points.push(decimalString(equity)); }
  return calculateBacktestMetrics(initialCapital, trades, points);
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
    await service.from("backtest_runs").update({ status: "running", started_at: run.started_at ?? new Date().toISOString() }).eq("id", run.id);
    try {
      const requestedStart = Date.parse(run.requested_start);
      const requestedEnd = Date.parse(run.requested_end);
      const [fiveMinuteCandles, oneHourCandles, metadata, feeInput] = await Promise.all([
        candles(asset, "5m", requestedStart, requestedEnd), candles(asset, "1h", requestedStart, requestedEnd),
        paper.loadAsset(asset), paper.loadFeeSchedule(),
      ]);
      if (!metadata) throw new Error(`asset metadata unavailable for ${asset}`);
      const feeRate = scalePerpFeeRate(selectFeeRate(feeInput.schedule, "0", "0", "taker"), metadata, "taker");
      const parameters = await service.from("strategy_revisions").select("parameters").eq("id", run.revision_id).single();
      if (parameters.error || !parameters.data) throw new Error(parameters.error?.message ?? "strategy revision unavailable");
      const allocation = String((parameters.data.parameters as Record<string, unknown>).marginAllocationPct ?? "10");
      const result = runDualRsiBacktest({ asset, fiveMinuteCandles, oneHourCandles, initialCapital: String(run.initial_capital),
        marginAllocationPct: allocation, maxLeverage: metadata.maxLeverage, marginTiers: metadata.marginTiers,
        takerFeeRate: feeRate, slippageBps: "2", tradableStartMs: requestedStart });
      const warmupStart = fiveMinuteCandles[114] && oneHourCandles[114]
        ? Math.max(requestedStart, fiveMinuteCandles[114].closeTime, oneHourCandles[114].closeTime)
        : null;
      const storedResult = { ...result, actualTradableStart: warmupStart };
      const tradeRows = result.trades.map((trade) => ({ run_id: run.id, asset: trade.asset, side: trade.side,
        entry_time: new Date(trade.entryTime).toISOString(), entry_price: trade.entryPrice,
        exit_time: new Date(trade.exitTime).toISOString(), exit_price: trade.exitPrice,
        initial_margin: trade.initialMargin, gross_pnl: trade.grossPnl, fees: trade.fees, funding: trade.funding,
        net_pnl: trade.netPnl, exit_reason: trade.exitReason, fidelity: result.fidelity }));
      if (tradeRows.length) {
        const { error } = await service.from("backtest_trades").insert(tradeRows);
        if (error) throw new Error(error.message);
      }
      const equityRows = result.equityTimeline.map((point) => ({ run_id: run.id, sampled_at: new Date(point.sampledAt).toISOString(), equity: point.equity, reason: point.reason }));
      if (equityRows.length) {
        const { error } = await service.from("backtest_equity_points").upsert(equityRows, { onConflict: "run_id,sampled_at,reason" });
        if (error) throw new Error(error.message);
      }
      const nextCompleted = [...completedAssets, asset];
      const nextResults = { ...(cursor.results ?? {}), [asset]: storedResult };
      const done = nextCompleted.length === (run.assets as string[]).length;
      const storedResults = Object.values(nextResults) as Array<{ trades: BacktestTrade[]; actualTradableStart: number | null; coverage: { fiveMinute: { start: number | null; end: number | null } }; metrics: unknown; fidelity: unknown }>;
      const starts = storedResults.map((item) => item.actualTradableStart).filter((value): value is number => value !== null);
      const ends = storedResults.map((item) => item.coverage.fiveMinute.end).filter((value): value is number => value !== null);
      const update: Record<string, unknown> = { work_cursor: { completedAssets: nextCompleted, results: nextResults },
        progress: Math.floor(nextCompleted.length / (run.assets as string[]).length * 100),
        actual_start: starts.length ? new Date(Math.max(...starts)).toISOString() : null,
        actual_end: ends.length ? new Date(Math.min(requestedEnd, ...ends)).toISOString() : null };
      if (done) Object.assign(update, { status: "completed", finished_at: new Date().toISOString(), metrics: {
        perAsset: Object.fromEntries(storedResults.map((item, index) => [(run.assets as string[])[index], item.metrics])),
        portfolio: portfolioMetrics(String(run.initial_capital), storedResults),
      }, assumptions: { entry: "next_bar", collision: "adverse_first", liquidation: "precedence", slippageBps: "2", funding: "unavailable", constraints: "current" } });
      const { error: updateError } = await service.from("backtest_runs").update(update).eq("id", run.id);
      if (updateError) throw new Error(updateError.message);
      return { processed: 1, completed: done ? 1 : 0, runId: run.id, asset };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await service.from("backtest_runs").update({ status: "failed", failure_reason: message, finished_at: new Date().toISOString() }).eq("id", run.id);
      return { processed: 1, completed: 0, failed: 1, runId: run.id, asset, error: message };
    }
  };
}
