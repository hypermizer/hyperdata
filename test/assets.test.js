import assert from "node:assert/strict";
import test from "node:test";
import {
  annualizedFundingApr,
  calculateHourlyRsi,
  hydrateTradFiMarkets,
  filterAndSortTradFiAssets,
  nextColumnSort,
  resolveAsset,
  searchAssets,
} from "../public/lib/assets.js";

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

test("TradFi asset view includes active xyz markets and supports search", () => {
  const markets = [
    ...catalog,
    { id: "xyz:DELISTED", symbol: "DELISTED", dexId: "xyz", isDelisted: true },
  ].map((market) => ({ ...market, dexId: market.dex === "xyz" ? "xyz" : market.dexId }));

  assert.deepEqual(
    filterAndSortTradFiAssets(markets, { query: "or" }).map(({ id }) => id),
    ["xyz:ORCL"],
  );
  assert.deepEqual(
    filterAndSortTradFiAssets(markets).map(({ id }) => id),
    ["xyz:ORCL", "xyz:XYZ100"],
  );
});

test("TradFi asset view hydrates catalog entries with the latest live market values", () => {
  const catalogMarkets = [
    { id: "xyz:ORCL", symbol: "ORCL", dexId: "xyz", markPrice: 100, funding: 0.0001 },
    { id: "xyz:DELISTED", symbol: "DELISTED", dexId: "xyz", isDelisted: true },
    { id: "BTC", symbol: "BTC", dexId: "", markPrice: 120000 },
  ];
  const liveMarkets = new Map([
    ["xyz:ORCL", { ...catalogMarkets[0], markPrice: 125, funding: 0.0002 }],
  ]);

  assert.deepEqual(hydrateTradFiMarkets(catalogMarkets, liveMarkets), [
    { ...catalogMarkets[0], markPrice: 125, funding: 0.0002 },
  ]);
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

  assert.deepEqual(filterAndSortTradFiAssets(markets, { sort: "volume-desc" }).map(({ id }) => id), ["xyz:BETA", "xyz:ALPHA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortTradFiAssets(markets, { sort: "move-5m-abs", priceHistories, now }).map(({ id }) => id), ["xyz:ALPHA", "xyz:BETA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortTradFiAssets(markets, { sort: "apr-asc" }).map(({ id }) => id), ["xyz:BETA", "xyz:ALPHA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortTradFiAssets(markets, { sort: "mark-desc" }).map(({ id }) => id), ["xyz:ALPHA", "xyz:GAMMA", "xyz:BETA"]);
  assert.deepEqual(filterAndSortTradFiAssets(markets, { sort: "volume-asc" }).map(({ id }) => id), ["xyz:ALPHA", "xyz:BETA", "xyz:GAMMA"]);
  assert.deepEqual(filterAndSortTradFiAssets(markets, {
    sort: "rsi-desc",
    rsiValues: new Map([["xyz:ALPHA", 62], ["xyz:BETA", 38]]),
  }).map(({ id }) => id), ["xyz:ALPHA", "xyz:BETA", "xyz:GAMMA"]);
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
    filterAndSortTradFiAssets(markets, { sort: "move-30m-desc", priceHistories, now }).map(({ id }) => id),
    ["xyz:ALPHA", "xyz:BETA"],
  );
  assert.deepEqual(
    filterAndSortTradFiAssets(markets, { sort: "move-30m-asc", priceHistories, now }).map(({ id }) => id),
    ["xyz:BETA", "xyz:ALPHA"],
  );
  assert.deepEqual(
    filterAndSortTradFiAssets(markets, { sort: "move-5m-desc", priceHistories, now }).map(({ id }) => id),
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
    filterAndSortTradFiAssets(markets, { sort: "move-30m-abs-desc", priceHistories, now }).map(({ id }) => id),
    ["xyz:DOWN", "xyz:UP", "xyz:FLAT", "xyz:MISSING"],
  );
  assert.deepEqual(
    filterAndSortTradFiAssets(markets, { sort: "move-30m-abs-asc", priceHistories, now }).map(({ id }) => id),
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
    filterAndSortTradFiAssets(markets, { sort: "volume-desc", watchedFirst: true, watched: ["xyz:A", "xyz:C"] }).map(({ id }) => id),
    ["xyz:C", "xyz:A", "xyz:B"],
  );
});
