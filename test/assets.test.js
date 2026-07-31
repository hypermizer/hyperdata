import assert from "node:assert/strict";
import test from "node:test";
import {
  annualizedFundingApr,
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
});

test("column sorting starts high-to-low and toggles direction", () => {
  assert.equal(nextColumnSort("asset-asc", "volume"), "volume-desc");
  assert.equal(nextColumnSort("volume-desc", "volume"), "volume-asc");
  assert.equal(nextColumnSort("volume-asc", "volume"), "volume-desc");
  assert.equal(nextColumnSort("volume-desc", "asset"), "asset-desc");
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
