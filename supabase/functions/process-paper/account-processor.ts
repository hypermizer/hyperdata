import { applyFill } from "../_shared/paper/accounting.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
import { executeOrder } from "../_shared/paper/execution.ts";
import type { NormalizedBook, NormalizedTrade } from "../_shared/paper/market-data.ts";
import { advanceMakerQueue, triggerCrossed } from "../_shared/paper/queue.ts";
import type { PaperPosition, Side } from "../_shared/paper/types.ts";
import type { MarginTier } from "../_shared/paper/types.ts";
import { initialMargin } from "../_shared/paper/margin.ts";

export interface ReplayOrder {
  id: string;
  side: Side;
  orderType: "limit" | "stop_market" | "stop_limit" | "take_market" | "take_limit";
  timeInForce: "GTC" | "ALO" | "IOC" | null;
  status: "resting" | "partially_filled" | "trigger_waiting";
  remainingSize: string;
  limitPrice: string | null;
  triggerPrice: string | null;
  queueAhead: string | null;
  reduceOnly: boolean;
  createdAtMs?: number;
}

export interface ReplaySnapshot {
  markPrice: string;
  book: NormalizedBook;
  trades: NormalizedTrade[];
  tradeGap: boolean;
  inputVersion: string;
}

export interface ReplayEffect {
  orderId: string;
  status: "resting" | "partially_filled" | "filled" | "canceled";
  remainingSize: string;
  queueAhead: string | null;
  fills: Array<{ price: string; size: string; fee: string; liquidity: "maker" | "taker"; sourceId: string; sourceTimestamp?: string }>;
  position: PaperPosition | null;
  realizedPnl: string;
  fee: string;
  reason?: string;
}

export function hasMatchMargin(
  current: PaperPosition | null,
  next: PaperPosition | null,
  markPrice: string,
  leverage: number,
  tiers: MarginTier[],
  availableMargin: string,
): boolean {
  const currentAbsolute = decimal(current?.signedSize ?? 0).abs();
  const nextAbsolute = decimal(next?.signedSize ?? 0).abs();
  const currentSigned = decimal(current?.signedSize ?? 0);
  const nextSigned = decimal(next?.signedSize ?? 0);
  const pureReduction = nextSigned.isZero() || (
    !currentSigned.isZero() && currentSigned.isPositive() === nextSigned.isPositive() &&
    nextAbsolute.lte(currentAbsolute)
  );
  if (pureReduction) return true;
  return decimal(initialMargin(decimalString(nextAbsolute.times(markPrice)), leverage, tiers)).lte(availableMargin);
}

function reduceOnlySize(order: ReplayOrder, position: PaperPosition | null, requested: string): string {
  if (!order.reduceOnly) return requested;
  const signed = decimal(position?.signedSize ?? 0);
  const reducing = order.side === "buy" ? signed.isNegative() : signed.isPositive();
  if (!reducing) return "0";
  const requestedSize = decimal(requested);
  return decimalString(requestedSize.lte(signed.abs()) ? requestedSize : signed.abs());
}

function transitionFills(
  order: ReplayOrder,
  position: PaperPosition | null,
  raw: Array<{ price: string; size: string; liquidity: "maker" | "taker"; sourceTimestamp?: string }>,
  makerFeeRate: string,
  takerFeeRate: string,
  inputVersion: string,
) {
  let nextPosition = position;
  let realized = decimal(0);
  let fees = decimal(0);
  const fills = raw.flatMap((fill, index) => {
    const size = reduceOnlySize(order, nextPosition, fill.size);
    if (decimal(size).isZero()) return [];
    const transition = applyFill(nextPosition, {
      side: order.side, size, price: fill.price,
      feeRate: fill.liquidity === "maker" ? makerFeeRate : takerFeeRate,
    });
    nextPosition = transition.position;
    realized = realized.plus(transition.realizedPnl);
    fees = fees.plus(transition.fee);
    return [{ ...fill, size, fee: transition.fee, sourceId: `${inputVersion}:${order.id}:${index}` }];
  });
  return { position: nextPosition, realizedPnl: decimalString(realized), fee: decimalString(fees), fills };
}

export function replayOrder(
  order: ReplayOrder,
  position: PaperPosition | null,
  snapshot: ReplaySnapshot,
  feeRates: { maker: string; taker: string },
): ReplayEffect | null {
  let activated = order.status !== "trigger_waiting";
  if (!activated) {
    const kind = order.orderType.startsWith("stop_") ? "stop" : "take";
    activated = order.triggerPrice !== null && triggerCrossed(order.side, kind, order.triggerPrice, snapshot.markPrice);
    if (!activated) return null;
  }

  const isTriggeredMarket = order.orderType === "stop_market" || order.orderType === "take_market";
  if (isTriggeredMarket) {
    const execution = executeOrder({
      side: order.side, size: order.remainingSize, type: "market", timeInForce: null,
      limitPrice: null, reduceOnly: order.reduceOnly,
    }, snapshot.book, position?.signedSize ?? "0");
    const transitioned = transitionFills(order, position,
      execution.fills.map((fill) => ({ ...fill, liquidity: "taker" as const })),
      feeRates.maker, feeRates.taker, snapshot.inputVersion);
    const filled = transitioned.fills.reduce((sum, fill) => sum.plus(fill.size), decimal(0));
    const remaining = decimal(order.remainingSize).minus(filled);
    return {
      orderId: order.id, status: remaining.isZero() ? "filled" : "canceled",
      remainingSize: decimalString(remaining), queueAhead: null, ...transitioned,
    };
  }

  if (order.limitPrice === null) throw new Error("replay limit order has no limit price");
  if (order.status === "trigger_waiting") {
    const execution = executeOrder({
      side: order.side, size: order.remainingSize, type: "limit", timeInForce: order.timeInForce ?? "GTC",
      limitPrice: order.limitPrice, reduceOnly: order.reduceOnly,
    }, snapshot.book, position?.signedSize ?? "0");
    const transitioned = transitionFills(order, position,
      execution.fills.map((fill) => ({ ...fill, liquidity: "taker" as const })),
      feeRates.maker, feeRates.taker, snapshot.inputVersion);
    const filled = transitioned.fills.reduce((sum, fill) => sum.plus(fill.size), decimal(0));
    const remaining = decimal(order.remainingSize).minus(filled);
    if (["canceled", "rejected"].includes(execution.status)) return {
      orderId: order.id, status: "canceled", remainingSize: decimalString(remaining),
      queueAhead: null, reason: execution.reason ?? undefined, ...transitioned,
    };
    if (execution.fills.length) return {
      orderId: order.id, status: remaining.isZero() ? "filled" : "partially_filled",
      remainingSize: decimalString(remaining), queueAhead: execution.queueAhead, ...transitioned,
    };
    return {
      orderId: order.id, status: "resting", remainingSize: order.remainingSize,
      queueAhead: execution.queueAhead, fills: [], position, realizedPnl: "0", fee: "0",
    };
  }

  const queue = advanceMakerQueue({
    side: order.side, price: order.limitPrice, remainingSize: order.remainingSize,
    queueAhead: order.queueAhead ?? "0",
  }, snapshot.trades.filter((trade) => trade.timestampMs > (order.createdAtMs ?? 0)), snapshot.tradeGap);
  if (snapshot.tradeGap) return null;
  const transitioned = transitionFills(order, position,
    queue.fills.map((fill) => ({
      price: order.limitPrice!, size: fill.size, liquidity: "maker" as const,
      sourceTimestamp: fill.timestampMs === undefined ? undefined : new Date(fill.timestampMs).toISOString(),
    })),
    feeRates.maker, feeRates.taker, snapshot.inputVersion);
  return {
    orderId: order.id,
    status: decimal(queue.remainingSize).isZero() ? "filled"
      : decimal(queue.filledSize).isZero() ? "resting" : "partially_filled",
    remainingSize: queue.remainingSize, queueAhead: queue.queueAhead, ...transitioned,
  };
}
