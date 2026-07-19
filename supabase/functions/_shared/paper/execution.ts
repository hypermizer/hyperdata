import { decimal, decimalString } from "./decimal.ts";
import type { NormalizedBook } from "./market-data.ts";
import type { Side } from "./types.ts";

export interface OrderExecutionIntent {
  side: Side;
  size: string;
  type: "market" | "limit";
  timeInForce: "GTC" | "ALO" | "IOC" | null;
  limitPrice: string | null;
  reduceOnly: boolean;
}

export interface ExecutionResult {
  status: "filled" | "resting" | "canceled" | "rejected";
  fills: Array<{ price: string; size: string }>;
  requestedSize: string;
  remainingSize: string;
  queueAhead: string | null;
  reason: string | null;
}

function rejection(size: string, reason: string): ExecutionResult {
  return {
    status: "rejected",
    fills: [],
    requestedSize: decimalString(size),
    remainingSize: decimalString(size),
    queueAhead: null,
    reason,
  };
}

export function executeOrder(
  intent: OrderExecutionIntent,
  book: NormalizedBook,
  currentSignedSize = "0",
): ExecutionResult {
  let requested = decimal(intent.size);
  if (!requested.isPositive()) return rejection(intent.size, "invalid_size");

  if (intent.reduceOnly) {
    const exposure = decimal(currentSignedSize);
    const reduces = (intent.side === "sell" && exposure.isPositive()) ||
      (intent.side === "buy" && exposure.isNegative());
    if (!reduces) return rejection(intent.size, "reduce_only_would_increase");
    if (requested.gt(exposure.abs())) requested = exposure.abs();
  }

  const levels = intent.side === "buy" ? book.asks : book.bids;
  const limit = intent.limitPrice === null ? null : decimal(intent.limitPrice);
  const crosses = levels.length > 0 && (limit === null ||
    (intent.side === "buy" ? decimal(levels[0].price).lte(limit) : decimal(levels[0].price).gte(limit)));
  if (intent.type === "limit" && intent.timeInForce === "ALO" && crosses) {
    return rejection(decimalString(requested), "post_only_would_cross");
  }

  let remaining = requested;
  const fills: Array<{ price: string; size: string }> = [];
  if (intent.type === "market" || crosses) {
    for (const level of levels) {
      const price = decimal(level.price);
      if (limit !== null) {
        const eligible = intent.side === "buy" ? price.lte(limit) : price.gte(limit);
        if (!eligible) break;
      }
      const available = decimal(level.size);
      const fillSize = remaining.lte(available) ? remaining : available;
      if (fillSize.isPositive()) fills.push({ price: level.price, size: decimalString(fillSize) });
      remaining = remaining.minus(fillSize);
      if (remaining.isZero()) break;
    }
  }

  if (remaining.isZero()) {
    return {
      status: "filled",
      fills,
      requestedSize: decimalString(requested),
      remainingSize: "0",
      queueAhead: null,
      reason: null,
    };
  }

  if (intent.type === "market" || intent.timeInForce === "IOC") {
    return {
      status: "canceled",
      fills,
      requestedSize: decimalString(requested),
      remainingSize: decimalString(remaining),
      queueAhead: null,
      reason: fills.length > 0 ? "visible_depth_exhausted" : "no_eligible_liquidity",
    };
  }

  const sameSide = intent.side === "buy" ? book.bids : book.asks;
  const queueAhead = sameSide
    .filter((level) => level.price === intent.limitPrice)
    .reduce((sum, level) => sum.plus(level.size), decimal(0));
  return {
    status: "resting",
    fills,
    requestedSize: decimalString(requested),
    remainingSize: decimalString(remaining),
    queueAhead: decimalString(queueAhead),
    reason: null,
  };
}
