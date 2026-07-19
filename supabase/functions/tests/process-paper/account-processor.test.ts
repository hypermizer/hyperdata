import { assertEquals } from "@std/assert";
import { replayOrder, type ReplayOrder, type ReplaySnapshot } from "../../process-paper/account-processor.ts";

const book = { asset: "ORCL", timestampMs: 1_000, bids: [{ price: "99", size: "10", orders: 2 }], asks: [{ price: "101", size: "2", orders: 1 }, { price: "102", size: "4", orders: 2 }] };
const baseOrder: ReplayOrder = { id: "o1", side: "buy", orderType: "limit", status: "resting", remainingSize: "2", limitPrice: "100", triggerPrice: null, queueAhead: "1", reduceOnly: false };
const snapshot = (overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot => ({ markPrice: "100", book, trades: [], tradeGap: false, inputVersion: "input-v1", ...overrides });
const fees = { maker: "-0.00001", taker: "0.00045" };

Deno.test("continuous public flow clears queue then creates a maker rebate", () => {
  const effect = replayOrder(baseOrder, null, snapshot({ trades: [
    { id: "1", timestampMs: 900, price: "100", size: "2.5", aggressor: "sell" },
  ] }), fees)!;
  assertEquals(effect.status, "partially_filled");
  assertEquals(effect.remainingSize, "0.5");
  assertEquals(effect.fills[0], { price: "100", size: "1.5", liquidity: "maker", fee: "-0.0015", sourceId: "input-v1:o1:0" });
  assertEquals(effect.position, { signedSize: "1.5", entryPrice: "100" });
});

Deno.test("trade gap refuses queue mutation", () => {
  assertEquals(replayOrder(baseOrder, null, snapshot({ tradeGap: true }), fees), null);
});

Deno.test("crossed stop market walks visible book once and cancels unavailable remainder", () => {
  const order: ReplayOrder = { ...baseOrder, orderType: "stop_market", status: "trigger_waiting", remainingSize: "8", limitPrice: null, triggerPrice: "105", queueAhead: null };
  const effect = replayOrder(order, null, snapshot({ markPrice: "106" }), fees)!;
  assertEquals(effect.status, "canceled");
  assertEquals(effect.remainingSize, "2");
  assertEquals(effect.fills.map(({ price, size }) => ({ price, size })), [{ price: "101", size: "2" }, { price: "102", size: "4" }]);
});

Deno.test("reduce-only replay cannot reverse exposure", () => {
  const effect = replayOrder({ ...baseOrder, side: "sell", reduceOnly: true, remainingSize: "5", queueAhead: "0" },
    { signedSize: "1", entryPrice: "90" }, snapshot({ trades: [{ id: "1", timestampMs: 900, price: "100", size: "5", aggressor: "buy" }] }), fees)!;
  assertEquals(effect.fills[0].size, "1");
  assertEquals(effect.position, null);
});
