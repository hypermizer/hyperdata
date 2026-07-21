import type { SupabaseClient } from "@supabase/supabase-js";
import { infoRequest } from "../_shared/hyperliquid.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
import { executeOrder, marketOrderLimit } from "../_shared/paper/execution.ts";
import { makerFraction, scalePerpFeeRate, selectFeeRate } from "../_shared/paper/fees.ts";
import type { NormalizedBook } from "../_shared/paper/market-data.ts";
import type { FeeSchedule, PaperAssetMetadata } from "../_shared/paper/types.ts";
import { evaluateDualRsi, transitionRearm } from "../_shared/strategies/dual-rsi.ts";
import { completedCandleBucket, entrySizing, executableStrategyReturn } from "../_shared/strategies/live.ts";
import type { DualRsiParameters, StrategyCandle, StrategyInterval } from "../_shared/strategies/types.ts";
import { handlePaperCommand, type PaperCommandDependencies } from "../paper-command/handler.ts";
import type { ProcessorSnapshot } from "./processor.ts";

const INTERVAL_MS: Record<StrategyInterval, number> = { "5m": 300_000, "1h": 3_600_000 };

interface RuntimeOptions {
  service: SupabaseClient;
  paperCommandDependencies: PaperCommandDependencies;
  executionEnabled: boolean;
  now(): number;
}

interface StrategySnapshotPayload {
  book: NormalizedBook;
  metadata: PaperAssetMetadata;
  feeSchedule: FeeSchedule;
}

interface RawCandle { t?: unknown; T?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; v?: unknown }

function normalizeCandles(asset: string, interval: StrategyInterval, payload: unknown, completedBefore: number): StrategyCandle[] {
  if (!Array.isArray(payload)) throw new Error("malformed strategy candle response");
  const width = INTERVAL_MS[interval];
  return payload.flatMap((raw) => {
    const item = raw as RawCandle;
    if (!Number.isSafeInteger(item.t) || typeof item.o !== "string" || typeof item.h !== "string" ||
      typeof item.l !== "string" || typeof item.c !== "string" || typeof item.v !== "string") return [];
    const openTime = Number(item.t);
    if (openTime + width > completedBefore) return [];
    return [{ asset, interval, openTime, closeTime: openTime + width, open: item.o, high: item.h,
      low: item.l, close: item.c, volume: item.v, completed: true,
      sourceVersion: `${asset}:${interval}:${openTime}:${String(item.T ?? openTime + width)}` }];
  }).sort((left, right) => left.openTime - right.openTime);
}

async function fetchCandles(asset: string, interval: StrategyInterval, endTime: number) {
  const width = INTERVAL_MS[interval];
  const payload = await infoRequest({ type: "candleSnapshot", req: { coin: asset, interval, startTime: endTime - 140 * width, endTime } });
  return normalizeCandles(asset, interval, payload, endTime);
}

function candleRow(candle: StrategyCandle) {
  return { asset: candle.asset, interval: candle.interval, open_time: new Date(candle.openTime).toISOString(),
    close_time: new Date(candle.closeTime).toISOString(), open: candle.open, high: candle.high, low: candle.low,
    close: candle.close, volume: candle.volume, source: "hyperliquid", source_version: candle.sourceVersion };
}

function fromRows(rows: Array<Record<string, unknown>>): StrategyCandle[] {
  return rows.map((row) => ({ asset: String(row.asset), interval: row.interval as StrategyInterval,
    openTime: Date.parse(String(row.open_time)), closeTime: Date.parse(String(row.close_time)),
    open: String(row.open), high: String(row.high), low: String(row.low), close: String(row.close),
    volume: String(row.volume), completed: true, sourceVersion: String(row.source_version) }));
}

function weightedFillPrice(fills: Array<{ price: string; size: string }>) {
  const size = fills.reduce((sum, fill) => sum.plus(fill.size), decimal(0));
  if (!size.isPositive()) throw new Error("strategy command produced no fills");
  return { size: decimalString(size), price: decimalString(fills.reduce((sum, fill) => sum.plus(decimal(fill.price).mul(fill.size)), decimal(0)).div(size)) };
}

export function createStrategyRuntime(options: RuntimeOptions) {
  const { service } = options;

  const markDegraded = async (assignmentId: string, reason: string) => {
    await service.from("strategy_assignments").update({ state: "degraded", degraded_reason: reason }).eq("id", assignmentId);
    return { evaluations: 0, actions: 0, degradedReason: reason };
  };

  const submit = async (assignment: Record<string, unknown>, snapshot: ProcessorSnapshot, command: Record<string, unknown>) => {
    const payload = snapshot.payload as StrategySnapshotPayload;
    const dependencies: PaperCommandDependencies = {
      ...options.paperCommandDependencies,
      enabled: true,
      authenticate: async () => ({ id: String(assignment.user_id), email: "jasonblick@zohomail.com" }),
      loadBook: async () => ({ book: payload.book, inputVersion: snapshot.inputVersion }),
      loadAsset: async () => payload.metadata,
      loadFeeSchedule: async () => ({ schedule: payload.feeSchedule, inputVersion: snapshot.inputVersion }),
      now: options.now,
    };
    const response = await handlePaperCommand(new Request("https://internal/strategy", {
      method: "POST", headers: { authorization: "Bearer internal-strategy", "content-type": "application/json" }, body: JSON.stringify(command),
    }), dependencies);
    const body = await response.json();
    if (!response.ok) throw new Error(`strategy paper command failed: ${JSON.stringify(body)}`);
    return body as Record<string, any>;
  };

  return async function processStrategy(epochId: string, snapshot: ProcessorSnapshot) {
    const { data: assignment, error: assignmentError } = await service.from("strategy_assignments")
      .select("*").eq("epoch_id", epochId).eq("asset", snapshot.asset).neq("state", "paused").maybeSingle();
    if (assignmentError) throw new Error(assignmentError.message);
    if (!assignment) return { evaluations: 0, actions: 0 };
    const payload = snapshot.payload as StrategySnapshotPayload;
    if (snapshot.degraded || options.now() - payload.book.timestampMs > 10_000) return await markDegraded(assignment.id, "stale_market_input");

    const [{ data: revision, error: revisionError }, { data: strategyPosition, error: positionError }] = await Promise.all([
      service.from("strategy_revisions").select("parameters").eq("id", assignment.revision_id).single(),
      service.from("strategy_positions").select("*").eq("assignment_id", assignment.id).in("state", ["open", "closing"]).maybeSingle(),
    ]);
    if (revisionError || positionError) throw new Error(revisionError?.message ?? positionError?.message);
    const parameters = revision.parameters as DualRsiParameters;

    if (strategyPosition) {
      const side = strategyPosition.side as "long" | "short";
      const exitSide = side === "long" ? "sell" : "buy";
      const protectedLimit = marketOrderLimit(payload.book, exitSide, payload.metadata.sizeDecimals);
      const execution = executeOrder({ side: exitSide, size: String(strategyPosition.entry_size), type: "market", timeInForce: null, limitPrice: protectedLimit, reduceOnly: true }, payload.book, side === "long" ? String(strategyPosition.entry_size) : `-${strategyPosition.entry_size}`);
      const executable = weightedFillPrice(execution.fills);
      const { data: feeVolume, error: feeError } = await service.rpc("paper_fee_volume", { p_epoch_id: epochId }).single();
      if (feeError) throw new Error(feeError.message);
      const volumes = feeVolume as { trailing_volume: unknown; maker_volume: unknown };
      const exitFeeRate = scalePerpFeeRate(selectFeeRate(payload.feeSchedule, String(volumes.trailing_volume), makerFraction(String(volumes.maker_volume), String(volumes.trailing_volume)), "taker"), payload.metadata, "taker");
      const { data: fundingRows, error: fundingError } = await service.from("paper_ledger_entries").select("amount")
        .eq("epoch_id", epochId).eq("asset", assignment.asset).eq("entry_type", "funding").gte("source_timestamp", strategyPosition.opened_at);
      if (fundingError) throw new Error(fundingError.message);
      const fundingCashflows = (fundingRows ?? []).reduce((sum, row) => sum.plus(row.amount), decimal(0));
      if (!fundingCashflows.eq(strategyPosition.funding_cashflows)) {
        await service.from("strategy_positions").update({ funding_cashflows: decimalString(fundingCashflows) }).eq("id", strategyPosition.id);
      }
      const netReturn = executableStrategyReturn({ side, size: String(strategyPosition.entry_size), entryPrice: String(strategyPosition.entry_price),
        entryInitialMargin: String(strategyPosition.entry_initial_margin), entryFees: String(strategyPosition.entry_fees), fundingCashflows: decimalString(fundingCashflows) }, executable.price, executable.size, exitFeeRate);
      await service.from("strategy_assignments").update({ last_net_return: netReturn }).eq("id", assignment.id);
      if (decimal(netReturn).lte(parameters.stopReturn) || decimal(netReturn).gte(parameters.takeReturn) || assignment.degraded_reason === "close_and_pause_requested") {
        const reason = decimal(netReturn).lte(parameters.stopReturn) ? "stop" : decimal(netReturn).gte(parameters.takeReturn) ? "take" : "pause";
        const idempotencyKey = `strategy:exit:${strategyPosition.id}:${reason}`;
        const { data: epoch, error: epochError } = await service.from("paper_account_epochs").select("version,epoch_number").eq("id", epochId).single();
        if (epochError || !epoch) throw new Error(epochError?.message ?? "active strategy epoch unavailable");
        const command = { type: "place_order", accountId: assignment.account_id, epochNumber: epoch.epoch_number,
          expectedVersion: Number(epoch.version), idempotencyKey, order: { asset: assignment.asset, side: exitSide,
            size: String(strategyPosition.entry_size), orderType: "market", timeInForce: null, limitPrice: null,
            leverage: payload.metadata.maxLeverage, marginMode: "cross", reduceOnly: true } };
        await service.from("strategy_actions").upsert({ assignment_id: assignment.id, action_kind: "exit", idempotency_key: idempotencyKey, payload: { reason, netReturn } }, { onConflict: "assignment_id,idempotency_key", ignoreDuplicates: true });
        const outcome = await submit(assignment, snapshot, command);
        await service.from("strategy_actions").update({ state: "succeeded", outcome }).eq("assignment_id", assignment.id).eq("idempotency_key", idempotencyKey);
        await service.from("strategy_positions").update({ state: "closed", exit_reason: reason, closed_at: new Date(options.now()).toISOString() }).eq("id", strategyPosition.id);
        await service.from("strategy_assignments").update({ state: reason === "pause" ? "paused" : "await_rearm", rearm_ready: false, degraded_reason: null, last_net_return: null }).eq("id", assignment.id);
        return { evaluations: 0, actions: 1 };
      }
      return { evaluations: 0, actions: 0 };
    }

    const completedFiveMinute = completedCandleBucket(options.now(), "5m");
    if (assignment.last_five_minute_close && Date.parse(assignment.last_five_minute_close) >= completedFiveMinute) return { evaluations: 0, actions: 0 };
    try {
      const [five, hour] = await Promise.all([fetchCandles(assignment.asset, "5m", completedFiveMinute), fetchCandles(assignment.asset, "1h", completedCandleBucket(options.now(), "1h"))]);
      const { error: candleError } = await service.from("strategy_candles").upsert([...five, ...hour].map(candleRow), { onConflict: "asset,interval,open_time" });
      if (candleError) throw new Error(candleError.message);
    } catch (error) {
      return await markDegraded(assignment.id, error instanceof Error ? error.message : String(error));
    }
    const load = async (interval: StrategyInterval) => {
      const { data, error } = await service.from("strategy_candles").select("*").eq("asset", assignment.asset).eq("interval", interval).order("open_time", { ascending: false }).limit(130);
      if (error) throw new Error(error.message);
      return fromRows((data ?? []).reverse());
    };
    let evaluation;
    try {
      const [fiveMinute, oneHour] = await Promise.all([load("5m"), load("1h")]);
      evaluation = evaluateDualRsi(fiveMinute, oneHour, assignment.rearm_ready, parameters);
    }
    catch (error) { return await markDegraded(assignment.id, error instanceof Error ? error.message : String(error)); }
    const evaluationRow = { assignment_id: assignment.id, five_minute_close: new Date(completedFiveMinute).toISOString(),
      one_hour_close: evaluation.oneHour ? new Date(evaluation.oneHour.candleCloseTime).toISOString() : null,
      five_minute_values: evaluation.fiveMinute, one_hour_values: evaluation.oneHour, decision: evaluation.decision,
      input_versions: { fiveMinute: evaluation.fiveMinute?.candleCloseTime, oneHour: evaluation.oneHour?.candleCloseTime } };
    const { data: storedEvaluation, error: evaluationError } = await service.from("strategy_evaluations").upsert(evaluationRow, { onConflict: "assignment_id,five_minute_close" }).select("id").single();
    if (evaluationError) throw new Error(evaluationError.message);
    const rearmed = !assignment.rearm_ready && evaluation.fiveMinute && evaluation.oneHour
      ? transitionRearm(false, evaluation.fiveMinute, evaluation.oneHour, parameters)
      : false;
    await service.from("strategy_assignments").update({ last_five_minute_close: new Date(completedFiveMinute).toISOString(),
      last_one_hour_close: evaluation.oneHour ? new Date(evaluation.oneHour.candleCloseTime).toISOString() : null,
      state: evaluation.status === "warming" ? "warming" : "armed", rearm_ready: rearmed || assignment.rearm_ready, degraded_reason: null }).eq("id", assignment.id);
    if (!options.executionEnabled || !["enter_long", "enter_short"].includes(evaluation.decision)) return { evaluations: 1, actions: 0 };

    const [{ data: summary, error: summaryError }, { data: epoch, error: epochError }] = await Promise.all([
      service.from("paper_account_summaries").select("withdrawable").eq("epoch_id", epochId).single(),
      service.from("paper_account_epochs").select("version,epoch_number").eq("id", epochId).single(),
    ]);
    if (summaryError || epochError) throw new Error(summaryError?.message ?? epochError?.message);
    const entrySide = evaluation.decision === "enter_long" ? "buy" : "sell";
    const reference = entrySide === "buy" ? payload.book.asks[0]?.price : payload.book.bids[0]?.price;
    if (!reference) return await markDegraded(assignment.id, "empty_book");
    const sizing = entrySizing(String(summary.withdrawable), String(assignment.margin_allocation_pct), reference, payload.metadata.sizeDecimals, payload.metadata.maxLeverage, payload.metadata.marginTiers);
    const idempotencyKey = `strategy:entry:${assignment.id}:${completedFiveMinute}`;
    const command = { type: "place_order", accountId: assignment.account_id, epochNumber: epoch.epoch_number,
      expectedVersion: Number(epoch.version), idempotencyKey, order: { asset: assignment.asset, side: entrySide, size: sizing.size,
        orderType: "market", timeInForce: null, limitPrice: null, leverage: sizing.leverage, marginMode: "cross", reduceOnly: false } };
    await service.from("strategy_actions").upsert({ assignment_id: assignment.id, evaluation_id: storedEvaluation.id, action_kind: "entry", idempotency_key: idempotencyKey, payload: command }, { onConflict: "assignment_id,idempotency_key", ignoreDuplicates: true });
    const outcome = await submit(assignment, snapshot, command);
    const fills = (outcome.fills ?? []) as Array<{ price: string; size: string; fee: string }>;
    const entry = weightedFillPrice(fills);
    const entryFees = fills.reduce((sum, fill) => sum.plus(fill.fee), decimal(0));
    const { data: paperPosition } = await service.from("paper_positions").select("id").eq("epoch_id", epochId).eq("asset", assignment.asset).maybeSingle();
    await service.from("strategy_positions").insert({ assignment_id: assignment.id, paper_position_id: paperPosition?.id ?? null,
      side: entrySide === "buy" ? "long" : "short", entry_size: entry.size, entry_price: entry.price,
      entry_initial_margin: sizing.margin, entry_fees: decimalString(entryFees), state: "open" });
    await service.from("strategy_actions").update({ state: "succeeded", outcome }).eq("assignment_id", assignment.id).eq("idempotency_key", idempotencyKey);
    await service.from("strategy_assignments").update({ state: "position_open", rearm_ready: false, last_net_return: null }).eq("id", assignment.id);
    return { evaluations: 1, actions: 1 };
  };
}
