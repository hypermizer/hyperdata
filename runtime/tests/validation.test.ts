import { assertEquals, assertThrows } from "@std/assert";
import { validateRule } from "../validation.ts";
Deno.test("server validates targets, directions, and exact asset venue independently of the browser", () => {
  assertEquals(
    validateRule({
      asset: "xyz:GOLD",
      detector: "fixed_price",
      configuration: { direction: "below", target: 0.00000012345 },
    }).dex,
    "xyz",
  );
  for (const target of [0, -1, NaN, Infinity, "100", null]) {
    assertThrows(() =>
      validateRule({
        asset: "BTC",
        configuration: { direction: "above", target },
      })
    );
  }
  assertThrows(() =>
    validateRule({
      asset: "BTC/../../x",
      configuration: { direction: "above", target: 100 },
    })
  );
  assertThrows(() =>
    validateRule({
      asset: "BTC",
      configuration: { direction: "either", target: 100 },
    })
  );
});
