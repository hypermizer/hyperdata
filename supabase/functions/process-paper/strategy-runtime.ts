import type { SupabaseClient } from "@supabase/supabase-js";
import { infoRequest } from "../_shared/hyperliquid.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
import { executeOrder, marketOrderLimit } from "../_shared/paper/execution.ts";
import { makerFraction, scalePerpFeeRate, selectFeeRate } from "../_shared/paper/fees.ts";
import { initialMargin } from "../_shared/paper/margin.ts";
import type { NormalizedBook } from "../_shared/paper/market-data.ts";
import type { FeeSchedule, PaperAssetMetadata } from "../_shared/paper/types.ts";
import { evaluateDualRsi, transitionRearm } from "../_shared/strategies/dual-rsi.ts";
import { assignmentStateAfterEvaluation, assignmentStateAfterExit, completedCandleBucket, entrySizing, executableStrategyReturn } from "../_shared/strategies/live.ts";
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

interface PaperCommandOutcome {
  fills?: Array<{ price: string; size: string; fee: string }>;
  [key: string]: unknown;
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

  const requireWrite = (result: { error: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
  };

  const markDegraded = async (assignmentId: string, reason: string) => {
    requireWrite(await service.from("strategy_assignments").update({ state: "degraded", degraded_reason: reason }).eq("id", assignmentId));
    return { evaluations: 0, actions: 0, degradedReason: reason };
  };

  const submit = async (assignment: Record<string, unknown>, snapshot: ProcessorSnapshot, command: Record<string, unknown>) => {
    const payload = snapshot.payload as StrategySnapshotPayload;
    const dependencies: PaperCommandDependencies = {
      ...options.paperCommandDependencies,
      enabled: true,
      authenticate: () => Promise.resolve({ id: String(assignment.user_id), email: "jasonblick@zohomail.com" }),
      loadBook: () => Promise.resolve({ book: payload.book, inputVersion: snapshot.inputVersion }),
      loadAsset: () => Promise.resolve(payload.metadata),
      loadFeeSchedule: () => Promise.resolve({ schedule: payload.feeSchedule, inputVersion: snapshot.inputVersion }),
      now: options.now,
    };
    let currentCommand = command;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handlePaperCommand(new Request("https://internal/strategy", {
        method: "POST", headers: { authorization: "Bearer internal-strategy", "content-type": "application/json" }, body: JSON.stringify(currentCommand),
      }), dependencies);
      const body = await response.json();
      if (response.ok) return body as PaperCommandOutcome;
      if (attempt === 0 && response.status === 409 && body?.error === "stale_account") {
        const { data: epoch, error } = await service.from("paper_account_epochs").select("version").eq("id", assignment.epoch_id).single();
        if (error || !epoch) throw new Error(error?.message ?? "active strategy epoch unavailable");
        currentCommand = { ...currentCommand, expectedVersion: Number(epoch.version) };
        continue;
      }
      throw new Error(`strategy paper command failed: ${JSON.stringify(body)}`);
    }
    throw new Error("strategy paper command retry exhausted");
  };

  const submitTracked = async (
    assignment: Record<string, unknown>, snapshot: ProcessorSnapshot, command: Record<string, unknown>,
    action: Record<string, unknown>, idempotencyKey: string,
  ) => {
    const { error: actionError } = await service.from("strategy_actions").upsert(action, {
      onConflict: "assignment_id,idempotency_key", ignoreDuplicates: true,
    });
    if (actionError) throw new Error(actionError.message);
    try {
      const outcome = await submit(assignment, snapshot, command);
      const { error } = await service.from("strategy_actions").update({ state: "succeeded", outcome, failure_reason: null })
        .eq("assignment_id", assignment.id).eq("idempotency_key", idempotencyKey);
      if (error) throw new Error(error.message);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const [actionFailure, assignmentFailure] = await Promise.all([
        service.from("strategy_actions").update({ state: "failed", failure_reason: message })
          .eq("assignment_id", assignment.id).eq("idempotency_key", idempotencyKey),
        service.from("strategy_assignments").update({ state: "degraded", degraded_reason: message }).eq("id", assignment.id),
      ]);
      if (actionFailure.error || assignmentFailure.error) {
        throw new Error(`${message}; failed to persist strategy failure: ${actionFailure.error?.message ?? assignmentFailure.error?.message}`);
      }
      throw error;
    }
  };

  return async function processStrategy(epochId: string, snapshot: ProcessorSnapshot) {
    const { data: assignment, error: assignmentError } = await service.from("strategy_assignments")
      .select("*").eq("epoch_id", epochId).eq("asset", snapshot.asset).neq("state", "paused").maybeSingle();
    if (assignmentError) throw new Error(assignmentError.message);
    if (!assignment) return { evaluations: 0, actions: 0 };
    const payload = snapshot.payload as StrategySnapshotPayload;
    if (snapshot.degraded || options.now() - payload.book.timestampMs > 10_000) return await markDegraded(assignment.id, "stale_market_input");

    const [{ data: revision, error: revisionError }, strategyPositionResult, { data: currentPaperPosition, error: paperPositionError }] = await Promise.all([
      service.from("strategy_revisions").select("parameters").eq("id", assignment.revision_id).single(),
      service.from("strategy_positions").select("*").eq("assignment_id", assignment.id).in("state", ["open", "closing"]).maybeSingle(),
      service.from("paper_positions").select("id,signed_size").eq("epoch_id", epochId).eq("asset", assignment.asset).maybeSingle(),
    ]);
    let { data: strategyPosition, error: positionError } = strategyPositionResult;
    if (revisionError || positionError || paperPositionError) throw new Error(revisionError?.message ?? positionError?.message ?? paperPositionError?.message);
    const parameters = revision.parameters as DualRsiParameters;

    if (!strategyPosition && currentPaperPosition) {
      const { data: entryAction, error: entryActionError } = await service.from("strategy_actions").select("outcome,payload")
        .eq("assignment_id", assignment.id).eq("action_kind", "entry").eq("state", "succeeded")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (entryActionError) throw new Error(entryActionError.message);
      const outcome = entryAction?.outcome as PaperCommandOutcome | undefined;
      const fills = outcome?.fills ?? [];
      const order = (entryAction?.payload as { order?: { leverage?: number } } | null)?.order;
      if (!fills.length || !Number.isInteger(order?.leverage)) return await markDegraded(assignment.id, "unattributed_paper_position");
      const entry = weightedFillPrice(fills);
      const entryFees = fills.reduce((sum, fill) => sum.plus(fill.fee), decimal(0));
      const entryMargin = initialMargin(decimalString(decimal(entry.price).mul(entry.size)), Number(order?.leverage), payload.metadata.marginTiers);
      const { data: recovered, error: recoveryError } = await service.from("strategy_positions").insert({
        assignment_id: assignment.id, paper_position_id: currentPaperPosition.id,
        side: decimal(currentPaperPosition.signed_size).isPositive() ? "long" : "short",
        entry_size: decimalString(decimal(currentPaperPosition.signed_size).abs()), entry_price: entry.price,
        entry_initial_margin: entryMargin, entry_fees: decimalString(entryFees), state: "open",
      }).select("*").single();
      if (recoveryError) throw new Error(recoveryError.message);
      strategyPosition = recovered;
    }

    if (strategyPosition) {
      const side = strategyPosition.side as "long" | "short";
      if (!currentPaperPosition) {
        const terminalState = assignmentStateAfterExit(assignment.state, "liquidated");
        requireWrite(await service.from("strategy_positions").update({ state: "liquidated", exit_reason: "paper_position_closed", closed_at: new Date(options.now()).toISOString() }).eq("id", strategyPosition.id));
        requireWrite(await service.from("strategy_assignments").update({ state: terminalState, rearm_ready: false, degraded_reason: "paper_position_closed", last_net_return: null }).eq("id", assignment.id));
        return { evaluations: 0, actions: 0, degradedReason: "paper_position_closed" };
      }
      const paperSignedSize = decimal(currentPaperPosition.signed_size);
      const paperSide = paperSignedSize.isPositive() ? "long" : "short";
      const ownershipMismatch = paperSide !== side || !paperSignedSize.abs().eq(strategyPosition.entry_size);
      const exitSize = decimalString(paperSignedSize.abs());
      const exitSide = paperSide === "long" ? "sell" : "buy";
      const protectedLimit = marketOrderLimit(payload.book, exitSide, payload.metadata.sizeDecimals);
      const execution = executeOrder({ side: exitSide, size: exitSize, type: "market", timeInForce: null, limitPrice: protectedLimit, reduceOnly: true }, payload.book, String(currentPaperPosition.signed_size));
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
        requireWrite(await service.from("strategy_positions").update({ funding_cashflows: decimalString(fundingCashflows) }).eq("id", strategyPosition.id));
      }
      const netReturn = executableStrategyReturn({ side, size: exitSize, entryPrice: String(strategyPosition.entry_price),
        entryInitialMargin: String(strategyPosition.entry_initial_margin), entryFees: String(strategyPosition.entry_fees), fundingCashflows: decimalString(fundingCashflows) }, executable.price, executable.size, exitFeeRate);
      requireWrite(await service.from("strategy_assignments").update({ last_net_return: netReturn }).eq("id", assignment.id));
      const pauseRequested = assignment.degraded_reason === "close_and_pause_requested";
      if (ownershipMismatch || pauseRequested || decimal(netReturn).lte(parameters.stopReturn) || decimal(netReturn).gte(parameters.takeReturn)) {
        const reason = ownershipMismatch ? "ownership_mismatch" : pauseRequested ? "pause" : decimal(netReturn).lte(parameters.stopReturn) ? "stop" : "take";
        const idempotencyKey = `strategy:exit:${strategyPosition.id}:${reason}`;
        const { data: epoch, error: epochError } = await service.from("paper_account_epochs").select("version,epoch_number").eq("id", epochId).single();
        if (epochError || !epoch) throw new Error(epochError?.message ?? "active strategy epoch unavailable");
        const command = { type: "place_order", accountId: assignment.account_id, epochNumber: epoch.epoch_number,
          expectedVersion: Number(epoch.version), idempotencyKey, order: { asset: assignment.asset, side: exitSide,
            size: exitSize, orderType: "market", timeInForce: null, limitPrice: null,
            leverage: payload.metadata.maxLeverage, marginMode: "cross", reduceOnly: true } };
        await submitTracked(assignment, snapshot, command, { assignment_id: assignment.id, action_kind: "exit", idempotency_key: idempotencyKey, payload: { reason, netReturn } }, idempotencyKey);
        requireWrite(await service.from("strategy_positions").update({ state: "closed", exit_reason: reason, closed_at: new Date(options.now()).toISOString() }).eq("id", strategyPosition.id));
        const terminalState = assignmentStateAfterExit(assignment.state, reason);
        requireWrite(await service.from("strategy_assignments").update({ state: terminalState, rearm_ready: false, degraded_reason: ownershipMismatch ? reason : null, last_net_return: null }).eq("id", assignment.id));
        if (reason === "pause") {
          requireWrite(await service.from("strategy_actions").update({ state: "succeeded", outcome: { exitAction: idempotencyKey } })
            .eq("assignment_id", assignment.id).eq("idempotency_key", `strategy:pause:${strategyPosition.id}`));
        }
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
      input_versions: {
        fiveMinute: evaluation.fiveMinute ? { closeTime: evaluation.fiveMinute.candleCloseTime, sourceVersion: evaluation.fiveMinute.sourceVersion } : null,
        oneHour: evaluation.oneHour ? { closeTime: evaluation.oneHour.candleCloseTime, sourceVersion: evaluation.oneHour.sourceVersion } : null,
      } };
    const { data: storedEvaluation, error: evaluationError } = await service.from("strategy_evaluations").upsert(evaluationRow, { onConflict: "assignment_id,five_minute_close" }).select("id").single();
    if (evaluationError) throw new Error(evaluationError.message);
    const rearmed = !assignment.rearm_ready && evaluation.fiveMinute && evaluation.oneHour
      ? transitionRearm(false, evaluation.fiveMinute, evaluation.oneHour, parameters)
      : false;
    const nextState = assignmentStateAfterEvaluation(evaluation.status === "warming" ? "warming" : "ready", assignment.rearm_ready, rearmed);
    requireWrite(await service.from("strategy_assignments").update({ last_five_minute_close: new Date(completedFiveMinute).toISOString(),
      last_one_hour_close: evaluation.oneHour ? new Date(evaluation.oneHour.candleCloseTime).toISOString() : null,
      state: nextState, rearm_ready: rearmed || assignment.rearm_ready, degraded_reason: null }).eq("id", assignment.id));
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
    const outcome = await submitTracked(assignment, snapshot, command, { assignment_id: assignment.id, evaluation_id: storedEvaluation.id, action_kind: "entry", idempotency_key: idempotencyKey, payload: command }, idempotencyKey);
    const fills = (outcome.fills ?? []) as Array<{ price: string; size: string; fee: string }>;
    const entry = weightedFillPrice(fills);
    const entryFees = fills.reduce((sum, fill) => sum.plus(fill.fee), decimal(0));
    const filledMargin = initialMargin(decimalString(decimal(entry.price).mul(entry.size)), sizing.leverage, payload.metadata.marginTiers);
    const { data: paperPosition, error: paperPositionLookupError } = await service.from("paper_positions").select("id").eq("epoch_id", epochId).eq("asset", assignment.asset).maybeSingle();
    if (paperPositionLookupError || !paperPosition) throw new Error(paperPositionLookupError?.message ?? "strategy entry position unavailable");
    requireWrite(await service.from("strategy_positions").insert({ assignment_id: assignment.id, paper_position_id: paperPosition.id,
      side: entrySide === "buy" ? "long" : "short", entry_size: entry.size, entry_price: entry.price,
      entry_initial_margin: filledMargin, entry_fees: decimalString(entryFees), state: "open" }));
    requireWrite(await service.from("strategy_assignments").update({ state: "position_open", rearm_ready: false, last_net_return: null }).eq("id", assignment.id));
    return { evaluations: 1, actions: 1 };
  };
}
