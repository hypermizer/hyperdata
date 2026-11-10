import { assertEquals, assertThrows } from "@std/assert";
import {
  candleHistoryPoints,
  historyCatalog,
  historySamples,
  repairRequestWeight,
} from "../market-history-data.ts";
Deno.test("mark history respects full universe indices across delisted assets and DEXes", () => {
  const catalog = historyCatalog([null, { name: "xyz" }], [{
    universe: [{ name: "BTC" }, { name: "OLD", isDelisted: true }, {
      name: "ETH",
    }],
  }, { universe: [{ name: "xyz:BTC" }] }]);
  assertEquals(
    historySamples({
      ctxs: [["", [{ markPx: "10" }, { markPx: "999" }, { markPx: "20" }]], [
        "xyz",
        [{ markPx: "30" }],
      ]],
    }, catalog),
    [{ asset: "BTC", price: "10" }, { asset: "ETH", price: "20" }, {
      asset: "xyz:BTC",
      price: "30",
    }],
  );
  assertThrows(() => historyCatalog([null], []));
});
Deno.test("mark history never persists an absent or invalid market quote", () => {
  const catalog = [{ asset: "BTC", dex: "", index: 0 }];
  for (const markPx of [null, undefined, "NaN", "0", "-1", "9".repeat(400)]) {
    assertEquals(historySamples({ ctxs: { "": [{ markPx }] } }, catalog), []);
  }
  assertEquals(historySamples({}, catalog), []);
});
Deno.test("historical candle repairs exclude future bars and do not invent a future close timestamp", () => {
  assertEquals(
    candleHistoryPoints([
      { t: 100, T: 199, c: "10" },
      { t: 200, T: 299, c: "11" },
      { t: 300, T: 399, c: "12" },
      { t: 150, T: 149, c: "9" },
      { t: 1, T: 2, c: "NaN" },
    ], 250),
    [{ time: 199, price: 10 }, { time: 250, price: 11 }],
  );
  assertEquals(
    repairRequestWeight({
      type: "candleSnapshot",
      req: { startTime: 0, endTime: 18000000 },
    }),
    22,
  );
});

Deno.test("the combined feed discovers appended markets and new DEXes without confusing delisted slots", async () => {
  const { historyFrameExtendsCatalog } = await import(
    "../market-history-data.ts"
  );
  const catalog = historyCatalog([null], [{
    universe: [{ name: "BTC" }, { name: "OLD", isDelisted: true }],
  }]);
  assertEquals(
    historyFrameExtendsCatalog({ ctxs: { "": [{}, {}] } }, catalog),
    false,
  );
  assertEquals(
    historyFrameExtendsCatalog({ ctxs: { "": [{}, {}, {}] } }, catalog),
    true,
  );
  assertEquals(
    historyFrameExtendsCatalog({ ctxs: [["xyz", [{}]]] }, catalog),
    true,
  );
});
