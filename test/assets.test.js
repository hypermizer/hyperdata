import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSET_CATEGORY_TABS,
  annualizedFundingApr,
  assetCategoryFor,
  assetStreamSubscriptions,
  calculateDailyVolatility,
  calculateHourlyRsi,
  hydrateAssetUniverse,
  filterAndSortAssets,
  formatFundingApr,
  formatMaxLeverage,
  marketChangePercentForWindow,
  unseenNewAssetIds,
  nextColumnSort,
  resolveAsset,
  searchAssets,
} from "../public/lib/assets.js";

test("asset move calculations reject references outside the window tolerance", () => {
  const now = Date.UTC(2026, 7, 6, 23, 20);
  const market = { markPrice: 120 };
  assert.equal(marketChangePercentForWindow(market, [
    { time: now - (30 * 60 * 1000) - (7 * 60 * 1000), price: 100 },
  ], 30 * 60 * 1000, now), null);
});

test("move sorting puts assets with fresh interval references before stale assets", () => {
  const now = Date.UTC(2026, 7, 6, 23, 20);
  const markets = [
    { id: "xyz:STALE", symbol: "STALE", dexId: "xyz", markPrice: 200 },
    { id: "xyz:FRESH", symbol: "FRESH", dexId: "xyz", markPrice: 110 },
  ];
  const priceHistories = new Map([
    ["xyz:STALE", [{ time: now - (37 * 60 * 1000), price: 100 }]],
    ["xyz:FRESH", [{ time: now - (30 * 60 * 1000), price: 100 }]],
  ]);

  assert.deepEqual(filterAndSortAssets(markets, {
    now,
    priceHistories,
    sort: "move-30m-abs-desc",
  }).map(({ id }) => id), ["xyz:FRESH", "xyz:STALE"]);
});

test("maximum leverage labels handle live metadata and unavailable values", () => {
  assert.equal(formatMaxLeverage(20), "20×");
  assert.equal(formatMaxLeverage("10"), "10×");
  assert.equal(formatMaxLeverage(null), "—×");
  assert.equal(formatMaxLeverage(0), "—×");
});

const catalog = [
  { id: "BTC", symbol: "BTC", dex: "Hyperliquid", markPrice: 120000, maxLeverage: 40 },
  { id: "xyz:ORCL", symbol: "ORCL", dex: "xyz", markPrice: 250, maxLeverage: 10 },
  { id: "xyz:XYZ100", symbol: "XYZ100", dex: "xyz", markPrice: 22000, maxLeverage: 10 },
  { id: "flx:ORCA", symbol: "ORCA", dex: "flx", markPrice: 3.25, maxLeverage: 5 },
];

test("asset search ranks matches and returns the full catalog for an empty query", () => {
  const extended = [...catalog, ...Array.from({ length: 20 }, (_, index) => ({
    id: `TEST${index}`, symbol: `TEST${index}`, dex: "Hyperliquid", markPrice: index, maxLeverage: 3,
  }))];
  assert.deepEqual(searchAssets(extended, "or", 10).map((asset) => asset.id), ["flx:ORCA", "xyz:ORCL"]);
  assert.equal(searchAssets(extended, "").length, extended.length);
  assert.equal(searchAssets(extended, "xyz:orcl", 10)[0].id, "xyz:ORCL");
});

test("asset resolution accepts canonical IDs and unambiguous symbols", () => {
  assert.equal(resolveAsset(catalog, "xyz:ORCL")?.id, "xyz:ORCL");
  assert.equal(resolveAsset(catalog, "ORCL")?.id, "xyz:ORCL");
  assert.equal(resolveAsset(catalog, "missing"), null);
});

test("funding APR annualizes Hyperliquid's hourly funding rate", () => {
  assert.equal(annualizedFundingApr(0.0001), 87.6);
  assert.equal(annualizedFundingApr(-0.00005), -43.8);
  assert.equal(annualizedFundingApr(null), null);
});

test("funding APR renders as a compact whole percentage", () => {
  assert.equal(formatFundingApr(0.0001), "+88%");
  assert.equal(formatFundingApr(-0.00005), "−44%");
  assert.equal(formatFundingApr(null), "—");
});

test("ALL includes every TradFi market and only the three core crypto markets", () => {
  const markets = [
    { id: "xyz:ORCL", symbol: "ORCL", dexId: "xyz" },
    { id: "xyz:XYZ100", symbol: "XYZ100", dexId: "xyz" },
    { id: "BTC", symbol: "BTC", dexId: "" },
    { id: "ETH", symbol: "ETH", dexId: "" },
    { id: "HYPE", symbol: "HYPE", dexId: "" },
    { id: "SOL", symbol: "SOL", dexId: "" },
    { id: "flx:ORCA", symbol: "ORCA", dexId: "flx" },
    { id: "xyz:DELISTED", symbol: "DELISTED", dexId: "xyz", isDelisted: true },
    { id: "DOGE", symbol: "DOGE", dexId: "", isDelisted: true },
  ];

  assert.deepEqual(
    filterAndSortAssets(markets, { query: "or" }).map(({ id }) => id),
    ["xyz:ORCL"],
  );
  assert.deepEqual(
    filterAndSortAssets(markets).map(({ id }) => id),
    ["BTC", "ETH", "HYPE", "xyz:ORCL", "xyz:XYZ100"],
  );
  assert.deepEqual(
    filterAndSortAssets(markets, { category: "crypto" }).map(({ id }) => id),
    ["BTC", "ETH", "HYPE", "SOL"],
  );
});

test("asset categories distinguish ETFs from equities using official annotations", () => {
  assert.deepEqual(ASSET_CATEGORY_TABS.map(({ value }) => value), [
    "all", "equities", "etfs", "commodities", "fx", "indices", "pre-ipo", "crypto", "new",
  ]);
  assert.equal(assetCategoryFor({ category: "stocks", keywords: ["oracle", "ai"] }), "equities");
  assert.equal(assetCategoryFor({ category: "stocks", keywords: ["memory", "ETF"] }), "etfs");
  assert.equal(assetCategoryFor({ category: "commodities" }), "commodities");
  assert.equal(assetCategoryFor({ category: "FX" }), "fx");
  assert.equal(assetCategoryFor({ category: "indices" }), "indices");
  assert.equal(assetCategoryFor({ category: "preipo" }), "pre-ipo");
  assert.equal(assetCategoryFor({ category: "unexpected" }), "other");
});

test("daily volatility is the sample deviation of rolling daily log returns", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 7, 5, 12);
  const logs = [0, 0.01, 0, 0.01];
  const points = logs.map((logPrice, index) => ({
    time: Math.floor(now / day) * day - (logs.length - index) * day + day - 1,
    price: Math.exp(logPrice),
  }));

  assert.ok(Math.abs(calculateDailyVolatility(points, 1, now, 4) - 1.154700538) < 0.000001);
  assert.equal(calculateDailyVolatility(points.slice(1), 1, now, 4), null);
});

test("TradFi asset filtering applies category and search together", () => {
  const markets = [
    { id: "xyz:ORCL", symbol: "ORCL", dexId: "xyz", category: "stocks", keywords: ["oracle"] },
    { id: "xyz:DRAM", symbol: "DRAM", dexId: "xyz", category: "stocks", keywords: ["etf", "memory"] },
    { id: "xyz:GOLD", symbol: "GOLD", dexId: "xyz", category: "commodities", keywords: ["metal"] },
  ];

  assert.deepEqual(filterAndSortAssets(markets, { category: "etfs" }).map(({ id }) => id), ["xyz:DRAM"]);
  assert.deepEqual(filterAndSortAssets(markets, { category: "equities", query: "or" }).map(({ id }) => id), ["xyz:ORCL"]);
});

test("NEW contains only assets first observed within the last seven days", () => {
  const now = Date.UTC(2026, 7, 5, 12);
  const markets = [
    { id: "xyz:NEW", symbol: "NEW", dexId: "xyz" },
    { id: "xyz:OLD", symbol: "OLD", dexId: "xyz" },
    { id: "xyz:UNKNOWN", symbol: "UNKNOWN", dexId: "xyz" },
    { id: "SOL", symbol: "SOL", dexId: "" },
    { id: "OLDCRYPTO", symbol: "OLDCRYPTO", dexId: "" },
    { id: "DELISTED", symbol: "DELISTED", dexId: "", isDelisted: true },
  ];
  const firstSeenAt = new Map([
    ["xyz:NEW", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()],
    ["xyz:OLD", new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString()],
    ["SOL", new Date(now - 24 * 60 * 60 * 1000).toISOString()],
    ["OLDCRYPTO", new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString()],
    ["DELISTED", new Date(now - 24 * 60 * 60 * 1000).toISOString()],
  ]);

  assert.deepEqual(filterAndSortAssets(markets, {
    category: "new", firstSeenAt, now,
  }).map(({ id }) => id), ["xyz:NEW", "SOL"]);
});

test("NEW includes the seven-day boundary and rejects future timestamps", () => {
  const now = Date.UTC(2026, 7, 5, 12);
  const week = 7 * 24 * 60 * 60 * 1000;
  const markets = [
    { id: "xyz:BOUNDARY", symbol: "BOUNDARY", dexId: "xyz" },
    { id: "xyz:TOO_OLD", symbol: "TOO_OLD", dexId: "xyz" },
    { id: "xyz:FUTURE", symbol: "FUTURE", dexId: "xyz" },
  ];
  const firstSeenAt = new Map([
    ["xyz:BOUNDARY", new Date(now - week).toISOString()],
    ["xyz:TOO_OLD", new Date(now - week - 1).toISOString()],
    ["xyz:FUTURE", new Date(now + 1).toISOString()],
  ]);

  assert.deepEqual(filterAndSortAssets(markets, {
    category: "new", firstSeenAt, now,
  }).map(({ id }) => id), ["xyz:BOUNDARY"]);
});

test("NEW activity includes only current listings that have not been acknowledged", () => {
  const now = Date.UTC(2026, 7, 5, 12);
  const markets = [
    { id: "xyz:SEEN", dexId: "xyz" },
    { id: "xyz:UNSEEN", dexId: "xyz" },
    { id: "xyz:OLD", dexId: "xyz" },
  ];
  const firstSeenAt = new Map([
    ["xyz:SEEN", new Date(now - 24 * 60 * 60 * 1000).toISOString()],
    ["xyz:UNSEEN", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()],
    ["xyz:OLD", new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString()],
  ]);

  assert.deepEqual(
    unseenNewAssetIds(markets, firstSeenAt, new Set(["xyz:SEEN"]), now),
    ["xyz:UNSEEN"],
  );
  assert.deepEqual(
    unseenNewAssetIds(markets, firstSeenAt, new Set(["xyz:SEEN", "xyz:UNSEEN"]), now),
    [],
  );
});

test("asset universe hydrates TradFi and crypto entries with the latest live market values", () => {
  const catalogMarkets = [
    { id: "xyz:ORCL", symbol: "ORCL", dexId: "xyz", markPrice: 100, funding: 0.0001 },
    { id: "xyz:DELISTED", symbol: "DELISTED", dexId: "xyz", isDelisted: true },
    { id: "BTC", symbol: "BTC", dexId: "", markPrice: 120000 },
  ];
  const liveMarkets = new Map([
    ["xyz:ORCL", { ...catalogMarkets[0], markPrice: 125, funding: 0.0002 }],
  ]);

  assert.deepEqual(hydrateAssetUniverse(catalogMarkets, liveMarkets), [
    { ...catalogMarkets[0], markPrice: 125, funding: 0.0002 },
    catalogMarkets[2],
  ]);
});

test("market stream subscriptions include native crypto, TradFi, and watchlist assets once", () => {
  assert.deepEqual(assetStreamSubscriptions([
    { id: "BTC" },
    { id: "xyz:ORCL" },
  ], ["BTC", "SOL"]), ["BTC", "xyz:ORCL", "SOL"]);
});

test("TradFi asset view sorts metrics with unavailable values last", () => {
  const now = Date.UTC(2026, 6, 31, 12);
  const markets = [
    { id: "xyz:ALPHA", symbol: "ALPHA", dexId: "xyz", markPrice: 110, volume24h: 20, openInterest: 5, funding: 0.0001, changePercent: 2 },
    { id: "xyz:BETA", symbol: "BETA", dexId: "xyz", markPrice: 90, volume24h: 50, openInterest: null, funding: -0.0002, changePercent: -8 },
    { id: "xyz:GAMMA", symbol: "GAMMA", dexId: "xyz", markPrice: 100, volume24h: null, openInterest: 20, funding: null, changePercent: null },
  ];
  const priceHistories = new Map([
    ["xyz:ALPHA", [{ time: now - 300_000, price: 100 }]],
    ["xyz:BETA", [{ time: now - 300_000, price: 100 }]],
  ]);

  assert.deepEqual(filterAndSortAssets(markets, { sort: "volume-desc" }).map(({ id }) => id), ["xyz:BETA", "xyz:ALPHA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortAssets(markets, { sort: "move-5m-abs", priceHistories, now }).map(({ id }) => id), ["xyz:ALPHA", "xyz:BETA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortAssets(markets, { sort: "apr-asc" }).map(({ id }) => id), ["xyz:BETA", "xyz:ALPHA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortAssets(markets, { sort: "mark-desc" }).map(({ id }) => id), ["xyz:ALPHA", "xyz:GAMMA", "xyz:BETA"]);
  assert.deepEqual(filterAndSortAssets(markets, { sort: "volume-asc" }).map(({ id }) => id), ["xyz:ALPHA", "xyz:BETA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortAssets(markets, {
    sort: "rsi-desc",
    rsiValues: new Map([["xyz:ALPHA", 62], ["xyz:BETA", 38]]),
  }).map(({ id }) => id), ["xyz:ALPHA", "xyz:BETA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortAssets(markets, {
    sort: "daily-volatility-desc",
    dailyVolatilityValues: new Map([["xyz:ALPHA", 1.2], ["xyz:BETA", 2.4]]),
  }).map(({ id }) => id), ["xyz:BETA", "xyz:ALPHA", "xyz:GAMMA"]);
});

test("column sorting starts high-to-low and toggles direction", () => {
  assert.equal(nextColumnSort("asset-asc", "volume"), "volume-desc");
  assert.equal(nextColumnSort("volume-desc", "volume"), "volume-asc");
  assert.equal(nextColumnSort("volume-asc", "volume"), "volume-desc");
  assert.equal(nextColumnSort("volume-desc", "asset"), "asset-desc");
});

test("signal columns toggle between largest and smallest absolute moves", () => {
  assert.equal(nextColumnSort("asset-asc", "move-30m"), "move-30m-abs-desc");
  assert.equal(nextColumnSort("move-30m-abs-desc", "move-30m"), "move-30m-abs-asc");
  assert.equal(nextColumnSort("move-30m-abs-asc", "move-30m"), "move-30m-abs-desc");
});

test("each signal column sorts by its own time window", () => {
  const now = Date.UTC(2026, 6, 31, 12);
  const markets = [
    { id: "xyz:ALPHA", symbol: "ALPHA", dexId: "xyz", markPrice: 100 },
    { id: "xyz:BETA", symbol: "BETA", dexId: "xyz", markPrice: 100 },
  ];
  const priceHistories = new Map([
    ["xyz:ALPHA", [
      { time: now - 30 * 60_000, price: 50 },
      { time: now - 5 * 60_000, price: 99 },
    ]],
    ["xyz:BETA", [
      { time: now - 30 * 60_000, price: 90 },
      { time: now - 5 * 60_000, price: 50 },
    ]],
  ]);

  assert.deepEqual(
    filterAndSortAssets(markets, { sort: "move-30m-desc", priceHistories, now }).map(({ id }) => id),
    ["xyz:ALPHA", "xyz:BETA"],
  );
  assert.deepEqual(
    filterAndSortAssets(markets, { sort: "move-30m-asc", priceHistories, now }).map(({ id }) => id),
    ["xyz:BETA", "xyz:ALPHA"],
  );
  assert.deepEqual(
    filterAndSortAssets(markets, { sort: "move-5m-desc", priceHistories, now }).map(({ id }) => id),
    ["xyz:BETA", "xyz:ALPHA"],
  );
});

test("signal magnitude sorting ignores direction and keeps unavailable values last", () => {
  const now = Date.UTC(2026, 6, 31, 12);
  const markets = [
    { id: "xyz:UP", symbol: "UP", dexId: "xyz", markPrice: 110 },
    { id: "xyz:DOWN", symbol: "DOWN", dexId: "xyz", markPrice: 70 },
    { id: "xyz:FLAT", symbol: "FLAT", dexId: "xyz", markPrice: 101 },
    { id: "xyz:MISSING", symbol: "MISSING", dexId: "xyz", markPrice: 100 },
  ];
  const priceHistories = new Map([
    ["xyz:UP", [{ time: now - 30 * 60_000, price: 100 }]],
    ["xyz:DOWN", [{ time: now - 30 * 60_000, price: 100 }]],
    ["xyz:FLAT", [{ time: now - 30 * 60_000, price: 100 }]],
  ]);

  assert.deepEqual(
    filterAndSortAssets(markets, { sort: "move-30m-abs-desc", priceHistories, now }).map(({ id }) => id),
    ["xyz:DOWN", "xyz:UP", "xyz:FLAT", "xyz:MISSING"],
  );
  assert.deepEqual(
    filterAndSortAssets(markets, { sort: "move-30m-abs-asc", priceHistories, now }).map(({ id }) => id),
    ["xyz:FLAT", "xyz:UP", "xyz:DOWN", "xyz:MISSING"],
  );
});

test("hourly RSI uses Wilder smoothing and the live mark as the current hourly close", () => {
  const hour = 60 * 60 * 1000;
  const now = Date.UTC(2026, 6, 31, 12, 30);
  const prices = [1, 2, 1, 3, 2];
  const points = prices.map((price, index) => ({
    time: now - (prices.length - index) * hour - 1,
    price,
  }));

  assert.ok(Math.abs(calculateHourlyRsi(points, 4, now, 3) - 75) < 0.000001);
  assert.equal(calculateHourlyRsi(points.slice(0, 2), 4, now, 3), null);
});

test("hourly RSI handles one-sided and flat price histories", () => {
  const hour = 60 * 60 * 1000;
  const now = Date.UTC(2026, 6, 31, 12, 30);
  const points = (prices) => prices.map((price, index) => ({
    time: now - (prices.length - index) * hour - 1,
    price,
  }));

  assert.equal(calculateHourlyRsi(points([1, 2, 3]), 4, now, 3), 100);
  assert.equal(calculateHourlyRsi(points([4, 3, 2]), 1, now, 3), 0);
  assert.equal(calculateHourlyRsi(points([2, 2, 2]), 2, now, 3), 50);
});

test("watched-first grouping preserves the selected sort within each group", () => {
  const markets = [
    { id: "xyz:A", symbol: "A", dexId: "xyz", volume24h: 10 },
    { id: "xyz:B", symbol: "B", dexId: "xyz", volume24h: 100 },
    { id: "xyz:C", symbol: "C", dexId: "xyz", volume24h: 50 },
  ];

  assert.deepEqual(
    filterAndSortAssets(markets, { sort: "volume-desc", watchedFirst: true, watched: ["xyz:A", "xyz:C"] }).map(({ id }) => id),
    ["xyz:C", "xyz:A", "xyz:B"],
  );
});
