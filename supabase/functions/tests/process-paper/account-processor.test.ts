import { assertEquals } from "@std/assert";
import { hasMatchMargin, replayOrder, type ReplayOrder, type ReplaySnapshot } from "../../process-paper/account-processor.ts";

const book = { asset: "ORCL", timestampMs: 1_000, bids: [{ price: "99", size: "10", orders: 2 }], asks: [{ price: "101", size: "2", orders: 1 }, { price: "102", size: "4", orders: 2 }] };
const baseOrder: ReplayOrder = { id: "o1", side: "buy", orderType: "limit", timeInForce: "GTC", status: "resting", remainingSize: "2", limitPrice: "100", triggerPrice: null, queueAhead: "1", reduceOnly: false };
const snapshot = (overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot => ({ markPrice: "100", book, trades: [], tradeGap: false, inputVersion: "input-v1", ...overrides });
const fees = { maker: "-0.00001", taker: "0.00045" };

Deno.test("continuous public flow clears queue then creates a maker rebate", () => {
  const effect = replayOrder(baseOrder, null, snapshot({ trades: [
    { id: "1", timestampMs: 900, price: "100", size: "2.5", aggressor: "sell" },
  ] }), fees)!;
  assertEquals(effect.status, "partially_filled");
  assertEquals(effect.remainingSize, "0.5");
  assertEquals(effect.fills[0], {
    price: "100", size: "1.5", liquidity: "maker", fee: "-0.0015",
    sourceId: "input-v1:o1:0", sourceTimestamp: "1970-01-01T00:00:00.900Z",
  });
  assertEquals(effect.position, { signedSize: "1.5", entryPrice: "100" });
});

Deno.test("trade gap refuses queue mutation", () => {
  assertEquals(replayOrder(baseOrder, null, snapshot({ tradeGap: true }), fees), null);
});

Deno.test("trade gap still permits mark-triggered risk processing", () => {
  const order: ReplayOrder = {
    ...baseOrder, orderType: "stop_market", status: "trigger_waiting",
    remainingSize: "1", limitPrice: null, triggerPrice: "105", queueAhead: null,
  };
  const effect = replayOrder(order, null, snapshot({ markPrice: "106", tradeGap: true }), fees)!;
  assertEquals(effect.status, "filled");
  assertEquals(effect.fills.map(({ price, size }) => ({ price, size })), [{ price: "101", size: "1" }]);
});

Deno.test("triggered limit preserves IOC and ALO semantics", () => {
  const triggered: ReplayOrder = {
    ...baseOrder, orderType: "stop_limit", status: "trigger_waiting",
    triggerPrice: "105", limitPrice: "101", queueAhead: null,
  };
  const ioc = replayOrder({ ...triggered, timeInForce: "IOC", remainingSize: "3" }, null,
    snapshot({ markPrice: "106" }), fees)!;
  assertEquals(ioc.status, "canceled");
  assertEquals(ioc.remainingSize, "1");
  const alo = replayOrder({ ...triggered, timeInForce: "ALO" }, null,
    snapshot({ markPrice: "106" }), fees)!;
  assertEquals(alo.status, "canceled");
  assertEquals(alo.reason, "post_only_would_cross");
});

Deno.test("crossed stop market walks visible book once and cancels unavailable remainder", () => {
  const order: ReplayOrder = { ...baseOrder, orderType: "stop_market", status: "trigger_waiting", remainingSize: "8", limitPrice: null, triggerPrice: "105", queueAhead: null };
  const effect = replayOrder(order, null, snapshot({ markPrice: "106" }), fees)!;
  assertEquals(effect.status, "canceled");
  assertEquals(effect.remainingSize, "2");
  assertEquals(effect.fills.map(({ price, size }) => ({ price, size })), [{ price: "101", size: "2" }, { price: "102", size: "4" }]);
});

Deno.test("crossed stop market respects the SDK five-percent protection limit", () => {
  const order: ReplayOrder = { ...baseOrder, orderType: "stop_market", status: "trigger_waiting", remainingSize: "8", limitPrice: null, triggerPrice: "105", queueAhead: null };
  const effect = replayOrder(order, null, snapshot({
    markPrice: "106", sizeDecimals: 2,
    book: { ...book, bids: [{ price: "99", size: "10", orders: 1 }], asks: [{ price: "101", size: "2", orders: 1 }, { price: "106", size: "6", orders: 1 }] },
  }), fees)!;
  assertEquals(effect.status, "canceled");
  assertEquals(effect.remainingSize, "6");
  assertEquals(effect.fills.map(({ price, size }) => ({ price, size })), [{ price: "101", size: "2" }]);
});

Deno.test("reduce-only replay cannot reverse exposure", () => {
  const effect = replayOrder({ ...baseOrder, side: "sell", reduceOnly: true, remainingSize: "5", queueAhead: "0" },
    { signedSize: "1", entryPrice: "90" }, snapshot({ trades: [{ id: "1", timestampMs: 900, price: "100", size: "5", aggressor: "buy" }] }), fees)!;
  assertEquals(effect.fills[0].size, "1");
  assertEquals(effect.position, null);
});

Deno.test("match-time margin permits reductions and rejects unsupported increases", () => {
  const tiers = [{ lowerBound: "0", maxLeverage: 10, maintenanceRate: "0.05", maintenanceDeduction: "0" }];
  assertEquals(hasMatchMargin(null, { signedSize: "100", entryPrice: "100" }, "100", 2, tiers, "1000"), false);
  assertEquals(hasMatchMargin(null, { signedSize: "10", entryPrice: "100" }, "100", 2, tiers, "500", "0.01"), false);
  assertEquals(hasMatchMargin({ signedSize: "2", entryPrice: "100" }, { signedSize: "1", entryPrice: "100" }, "100", 2, tiers, "0"), true);
  assertEquals(hasMatchMargin({ signedSize: "2", entryPrice: "100" }, { signedSize: "-1", entryPrice: "100" }, "100", 2, tiers, "0"), false);
  assertEquals(hasMatchMargin({ signedSize: "-2", entryPrice: "100" }, { signedSize: "1", entryPrice: "100" }, "100", 2, tiers, "100"), true);
});
