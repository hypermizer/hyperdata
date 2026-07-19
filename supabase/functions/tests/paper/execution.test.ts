import { assertEquals } from "@std/assert";
import { executeOrder, validTriggerSide } from "../../_shared/paper/execution.ts";

const book = {
  asset: "xyz:ORCL",
  timestampMs: 1_000,
  bids: [{ price: "99", size: "2", orders: 1 }],
  asks: [{ price: "100", size: "0.5", orders: 1 }, { price: "101", size: "0.5", orders: 1 }],
};

Deno.test("market buy walks visible depth and cancels no remainder", () => {
  const result = executeOrder({ side: "buy", size: "0.75", type: "market", timeInForce: null, limitPrice: null, reduceOnly: false }, book);
  assertEquals(result.status, "filled");
  assertEquals(result.fills, [{ price: "100", size: "0.5" }, { price: "101", size: "0.25" }]);
  assertEquals(result.remainingSize, "0");
});

Deno.test("market order never extrapolates beyond visible depth", () => {
  const result = executeOrder({ side: "buy", size: "2", type: "market", timeInForce: null, limitPrice: null, reduceOnly: false }, book);
  assertEquals(result.status, "canceled");
  assertEquals(result.fills, [{ price: "100", size: "0.5" }, { price: "101", size: "0.5" }]);
  assertEquals(result.remainingSize, "1");
  assertEquals(result.reason, "visible_depth_exhausted");
});

Deno.test("post-only crossing rejects while non-marketable GTC rests", () => {
  assertEquals(executeOrder({ side: "buy", size: "1", type: "limit", timeInForce: "ALO", limitPrice: "100", reduceOnly: false }, book).status, "rejected");
  const resting = executeOrder({ side: "buy", size: "1", type: "limit", timeInForce: "GTC", limitPrice: "98", reduceOnly: false }, book);
  assertEquals(resting.status, "resting");
  assertEquals(resting.queueAhead, "0");
});

Deno.test("empty IOC cancels and crossing GTC rests only its remainder", () => {
  assertEquals(executeOrder({ side: "buy", size: "1", type: "limit", timeInForce: "IOC", limitPrice: "98", reduceOnly: false }, book).status, "canceled");
  const partial = executeOrder({ side: "buy", size: "1.5", type: "limit", timeInForce: "GTC", limitPrice: "100", reduceOnly: false }, book);
  assertEquals(partial.fills, [{ price: "100", size: "0.5" }]);
  assertEquals(partial.status, "resting");
  assertEquals(partial.remainingSize, "1");
});

Deno.test("reduce-only caps at exposure and never reverses", () => {
  const capped = executeOrder({ side: "sell", size: "5", type: "market", timeInForce: null, limitPrice: null, reduceOnly: true }, book, "2");
  assertEquals(capped.requestedSize, "2");
  const rejected = executeOrder({ side: "buy", size: "1", type: "market", timeInForce: null, limitPrice: null, reduceOnly: true }, book, "2");
  assertEquals(rejected.status, "rejected");
  assertEquals(rejected.reason, "reduce_only_would_increase");
});

Deno.test("stop and take triggers must be on the executable side of mark", () => {
  assertEquals(validTriggerSide("sell", "stop", "90", "100"), true);
  assertEquals(validTriggerSide("sell", "take", "110", "100"), true);
  assertEquals(validTriggerSide("buy", "stop", "110", "100"), true);
  assertEquals(validTriggerSide("buy", "take", "90", "100"), true);
  assertEquals(validTriggerSide("sell", "stop", "110", "100"), false);
  assertEquals(validTriggerSide("buy", "take", "110", "100"), false);
});
