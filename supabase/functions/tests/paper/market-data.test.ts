import { assertEquals, assertThrows } from "@std/assert";
import {
  deriveMarginTiers,
  fundingCacheIsFresh,
  fetchPaperCatalog,
  normalizeBook,
  normalizeFeeSchedule,
  normalizeFundingHistory,
  normalizePerpCatalog,
  normalizeTrades,
  RequestBudget,
} from "../../_shared/paper/market-data.ts";

const dexes = [{ name: null }, { name: "xyz" }, { name: "flx" }];
const metas = [
  {
    collateralToken: 0,
    universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 56 }],
    marginTables: [[56, { marginTiers: [{ lowerBound: "0", maxLeverage: 40 }, { lowerBound: "150000000", maxLeverage: 20 }] }]],
  },
  {
    collateralToken: 0,
    universe: [{ name: "xyz:ORCL", szDecimals: 4, maxLeverage: 20, marginTableId: 50, onlyIsolated: true }],
    marginTables: [[50, { marginTiers: [{ lowerBound: "0", maxLeverage: 50 }] }]],
  },
  {
    collateralToken: 360,
    universe: [{ name: "flx:US500", szDecimals: 2, maxLeverage: 20, marginTableId: 50 }],
    marginTables: [[50, { marginTiers: [{ lowerBound: "0", maxLeverage: 50 }] }]],
  },
] satisfies Parameters<typeof normalizePerpCatalog>[1];

Deno.test("catalog admits only non-delisted collateral-token-zero perps", () => {
  const catalog = normalizePerpCatalog(dexes, metas);
  assertEquals(catalog.map((asset) => asset.asset), ["BTC", "xyz:ORCL"]);
  assertEquals(catalog[1], {
    asset: "xyz:ORCL",
    dex: "xyz",
    collateralToken: 0,
    sizeDecimals: 4,
    maxLeverage: 20,
    marginTableId: 50,
    onlyIsolated: true,
    marginMode: null,
    growthMode: null,
    deployerFeeScale: null,
    marginTiers: [{ lowerBound: "0", maxLeverage: 50, maintenanceRate: "0.01", maintenanceDeduction: "0" }],
  });
});

Deno.test("catalog rejects an asset whose margin table is missing", () => {
  assertThrows(
    () => normalizePerpCatalog([{ name: "xyz" }], [{ collateralToken: 0, universe: [{ name: "xyz:BAD", szDecimals: 2, maxLeverage: 5, marginTableId: 999 }], marginTables: [] }]),
    Error,
    "missing margin table",
  );
});

Deno.test("legacy leverage-id assets derive an untiered margin table", () => {
  const [legacy] = normalizePerpCatalog([{ name: null }], [{
    collateralToken: 0,
    universe: [{ name: "ATOM", szDecimals: 2, maxLeverage: 5 }],
    marginTables: [],
  }]);
  assertEquals(legacy.marginTiers, [{
    lowerBound: "0",
    maxLeverage: 5,
    maintenanceRate: "0.1",
    maintenanceDeduction: "0",
  }]);
  assertEquals(legacy.marginTableId, 5);
});

Deno.test("derived maintenance deductions are continuous", () => {
  assertEquals(deriveMarginTiers([
    { lowerBound: "0", maxLeverage: 20 },
    { lowerBound: "100000", maxLeverage: 10 },
  ]), [
    { lowerBound: "0", maxLeverage: 20, maintenanceRate: "0.025", maintenanceDeduction: "0" },
    { lowerBound: "100000", maxLeverage: 10, maintenanceRate: "0.05", maintenanceDeduction: "2500" },
  ]);
});

Deno.test("book normalization preserves every level and decimal string", () => {
  assertEquals(normalizeBook({
    coin: "xyz:ORCL",
    time: 1234,
    levels: [[{ px: "100.10", sz: "2.500", n: 3 }], [{ px: "100.20", sz: "4", n: 1 }]],
  }), {
    asset: "xyz:ORCL",
    timestampMs: 1234,
    bids: [{ price: "100.10", size: "2.500", orders: 3 }],
    asks: [{ price: "100.20", size: "4", orders: 1 }],
  });
});

Deno.test("trade cursor overlap deduplicates and gaps fail closed", () => {
  const continuous = normalizeTrades([
    { tid: 12, time: 1200, px: "101", sz: "1", side: "B" },
    { tid: 11, time: 1100, px: "100", sz: "2", side: "A" },
  ], { lastTradeId: "11", lastTimestampMs: 1100 });
  assertEquals(continuous.gap, false);
  assertEquals(continuous.trades.map((trade) => trade.id), ["12"]);
  assertEquals(continuous.cursor.lastTradeId, "12");

  const gap = normalizeTrades([{ tid: 15, time: 1500, px: "105", sz: "1", side: "B" }], {
    lastTradeId: "12",
    lastTimestampMs: 1200,
  });
  assertEquals(gap.gap, true);
  assertEquals(gap.trades, []);
  assertEquals(gap.cursor, { lastTradeId: "15", lastTimestampMs: 1500 });

  const sameMillisecond = normalizeTrades([
    { tid: 10, time: 2000, px: "102", sz: "1", side: "B" },
    { tid: 9, time: 2000, px: "101", sz: "1", side: "B" },
  ], { lastTradeId: null, lastTimestampMs: null });
  assertEquals(sameMillisecond.trades.map((trade) => trade.id), ["9", "10"]);
  assertEquals(sameMillisecond.cursor.lastTradeId, "10");
});

Deno.test("funding history is chronological and idempotently deduplicated", () => {
  assertEquals(normalizeFundingHistory([
    { coin: "xyz:ORCL", fundingRate: "0.00002", premium: "0.1", time: 2000 },
    { coin: "xyz:ORCL", fundingRate: "0.00001", premium: "0.0", time: 1000 },
    { coin: "xyz:ORCL", fundingRate: "0.00001", premium: "0.0", time: 1000 },
  ]).map((point) => point.timestampMs), [1000, 2000]);
});

Deno.test("funding cache is reused for five minutes and then refreshed", () => {
  const now = Date.parse("2026-07-22T16:30:00.000Z");
  assertEquals(fundingCacheIsFresh("2026-07-22T16:25:00.001Z", now), true);
  assertEquals(fundingCacheIsFresh("2026-07-22T16:25:00.000Z", now), false);
  assertEquals(fundingCacheIsFresh("not-a-timestamp", now), false);
});

Deno.test("public fee schedule retains base, VIP, and maker rebate tiers", () => {
  assertEquals(normalizeFeeSchedule({ feeSchedule: {
    cross: "0.00045",
    add: "0.00015",
    tiers: {
      vip: [{ ntlCutoff: "5000000.0", cross: "0.0004", add: "0.00012" }],
      mm: [{ makerFractionCutoff: "0.005", add: "-0.00001" }],
    },
  } }), {
    volumeTiers: [
      { minimumVolume: "0", makerRate: "0.00015", takerRate: "0.00045" },
      { minimumVolume: "5000000", makerRate: "0.00012", takerRate: "0.0004" },
    ],
    makerFractionTiers: [{ minimumMakerFraction: "0.005", makerRate: "-0.00001" }],
  });
});

Deno.test("request budget fails closed before exceeding its limit", () => {
  const budget = new RequestBudget(20);
  assertEquals(budget.tryConsume(2), true);
  assertEquals(budget.tryConsume(18), true);
  assertEquals(budget.tryConsume(1), false);
  assertEquals(budget.used, 20);
});

Deno.test("catalog fetch uses public metadata requests and returns a version", async () => {
  const requestTypes: string[] = [];
  const mock = async (_url: string | URL | Request, init?: RequestInit) => {
    const type = JSON.parse(String(init?.body)).type;
    requestTypes.push(type);
    return new Response(JSON.stringify(type === "perpDexs" ? [{ name: "xyz" }] : [metas[1]]));
  };
  const result = await fetchPaperCatalog(mock as typeof fetch, 0);
  assertEquals(requestTypes.sort(), ["allPerpMetas", "perpDexs"]);
  assertEquals(result.assets.map((item) => item.asset), ["xyz:ORCL"]);
  assertEquals(result.inputVersion.length, 64);
});
