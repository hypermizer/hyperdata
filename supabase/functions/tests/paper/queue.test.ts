import { assertEquals } from "@std/assert";
import { advanceMakerQueue, triggerCrossed } from "../../_shared/paper/queue.ts";

const order = { side: "buy" as const, price: "100", remainingSize: "5", queueAhead: "10" };

Deno.test("maker queue does not fill until observed flow clears quantity ahead", () => {
  assertEquals(advanceMakerQueue(order, [
    { aggressor: "sell", price: "100", size: "8" },
  ], false), { queueAhead: "2", remainingSize: "5", filledSize: "0" });
  assertEquals(advanceMakerQueue(order, [
    { aggressor: "sell", price: "100", size: "12" },
  ], false), { queueAhead: "0", remainingSize: "3", filledSize: "2" });
});

Deno.test("trade-through fills after queue while irrelevant flow is ignored", () => {
  assertEquals(advanceMakerQueue({ ...order, queueAhead: "1" }, [
    { aggressor: "buy", price: "100", size: "20" },
    { aggressor: "sell", price: "99", size: "4" },
  ], false), { queueAhead: "0", remainingSize: "2", filledSize: "3" });
});

Deno.test("cursor gap suspends maker fills without mutating queue", () => {
  assertEquals(advanceMakerQueue(order, [{ aggressor: "sell", price: "99", size: "100" }], true), {
    queueAhead: "10", remainingSize: "5", filledSize: "0",
  });
});

Deno.test("mark price activates stop and take orders on the correct side", () => {
  assertEquals(triggerCrossed("sell", "stop", "90", "89"), true);
  assertEquals(triggerCrossed("sell", "take", "110", "111"), true);
  assertEquals(triggerCrossed("buy", "stop", "110", "111"), true);
  assertEquals(triggerCrossed("buy", "take", "90", "89"), true);
  assertEquals(triggerCrossed("sell", "stop", "90", "91"), false);
});
