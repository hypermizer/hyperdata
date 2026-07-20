import { decimal, decimalString } from "./decimal.ts";
import type { Side } from "./types.ts";

interface QueueOrder { side: Side; price: string; remainingSize: string; queueAhead: string }
interface QueueTrade { aggressor: "buy" | "sell"; price: string; size: string; timestampMs?: number }

export function advanceMakerQueue(order: QueueOrder, trades: QueueTrade[], gap: boolean) {
  if (gap) return { queueAhead: order.queueAhead, remainingSize: order.remainingSize, filledSize: "0", fills: [] };
  let queue = decimal(order.queueAhead);
  let remaining = decimal(order.remainingSize);
  let filled = decimal(0);
  const fills: Array<{ size: string; timestampMs?: number }> = [];
  for (const trade of trades) {
    const relevantSide = order.side === "buy" ? trade.aggressor === "sell" : trade.aggressor === "buy";
    const relevantPrice = order.side === "buy"
      ? decimal(trade.price).lte(order.price)
      : decimal(trade.price).gte(order.price);
    if (!relevantSide || !relevantPrice || remaining.isZero()) continue;
    let flow = decimal(trade.size);
    const queueConsumed = flow.lte(queue) ? flow : queue;
    queue = queue.minus(queueConsumed);
    flow = flow.minus(queueConsumed);
    const orderFill = flow.lte(remaining) ? flow : remaining;
    remaining = remaining.minus(orderFill);
    filled = filled.plus(orderFill);
    if (!orderFill.isZero()) fills.push({ size: decimalString(orderFill), timestampMs: trade.timestampMs });
  }
  return {
    queueAhead: decimalString(queue),
    remainingSize: decimalString(remaining),
    filledSize: decimalString(filled),
    fills,
  };
}

export function triggerCrossed(
  side: Side,
  kind: "stop" | "take",
  triggerPrice: string,
  markPrice: string,
): boolean {
  const trigger = decimal(triggerPrice);
  const mark = decimal(markPrice);
  if (kind === "stop") return side === "buy" ? mark.gte(trigger) : mark.lte(trigger);
  return side === "buy" ? mark.lte(trigger) : mark.gte(trigger);
}
