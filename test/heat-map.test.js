import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { focusedHeatMapAsset, heatMapTone, restoreHeatMapFocus, watchedHeatMapMarkets, watchedHeatMapTiles } from "../public/lib/heat-map.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("heat-map tone preserves direction and increases intensity with the 24-hour move", () => {
  assert.deepEqual(heatMapTone(null), { direction: "neutral", intensity: "unavailable" });
  assert.deepEqual(heatMapTone(0), { direction: "neutral", intensity: "flat" });
  assert.deepEqual(heatMapTone(0.4), { direction: "positive", intensity: "subtle" });
  assert.deepEqual(heatMapTone(-1.2), { direction: "negative", intensity: "medium" });
  assert.deepEqual(heatMapTone(2.5), { direction: "positive", intensity: "strong" });
  assert.deepEqual(heatMapTone(-5), { direction: "negative", intensity: "extreme" });
  assert.deepEqual(heatMapTone(0.5), { direction: "positive", intensity: "medium" });
  assert.deepEqual(heatMapTone(2), { direction: "positive", intensity: "strong" });
  assert.deepEqual(heatMapTone(4), { direction: "positive", intensity: "extreme" });
});

test("heat-map view models bind each watched market to its live tone", () => {
  const markets = [
    { id: "BTC", markPrice: 63_000, changePercent: 2.1 },
    { id: "ETH", markPrice: 3_200, changePercent: null },
  ];

  assert.deepEqual(watchedHeatMapTiles(markets, ["ETH", "BTC"]), [
    { market: markets[0], tone: { direction: "positive", intensity: "strong" } },
    { market: markets[1], tone: { direction: "neutral", intensity: "unavailable" } },
  ]);
  assert.deepEqual(watchedHeatMapTiles(markets, []), []);
});

test("live heat-map replacement preserves keyboard focus without announcing the full grid", () => {
  const focusCalls = [];
  const oldTile = { dataset: { heatMapAsset: "BTC" } };
  const newTile = { dataset: { heatMapAsset: "BTC" }, focus: (options) => focusCalls.push(options) };
  const container = {
    contains: (element) => element === oldTile,
    querySelectorAll: () => [newTile],
  };

  const focusedAsset = focusedHeatMapAsset(container, oldTile);
  restoreHeatMapFocus(container, focusedAsset);

  assert.equal(focusedAsset, "BTC");
  assert.deepEqual(focusCalls, [{ preventScroll: true }]);
  assert.doesNotMatch(html, /id="heat-map-grid"[^>]*aria-live/);
});

test("heat map contains watched markets only and prioritizes the largest absolute moves", () => {
  const markets = [
    { id: "BTC", changePercent: 1.2 },
    { id: "ETH", changePercent: -4.5 },
    { id: "SOL", changePercent: 8 },
    { id: "xyz:ORCL", changePercent: 0.3 },
  ];

  assert.deepEqual(
    watchedHeatMapMarkets(markets, ["BTC", "ETH", "xyz:ORCL"]).map(({ id }) => id),
    ["ETH", "BTC", "xyz:ORCL"],
  );
});

test("heat map sorts unavailable moves behind a genuine zero-percent move", () => {
  const markets = [
    { id: "AAA", changePercent: null },
    { id: "BBB", changePercent: undefined },
    { id: "CCC", changePercent: "" },
    { id: "DDD", changePercent: "   " },
    { id: "ZZZ", changePercent: 0 },
  ];

  assert.deepEqual(
    watchedHeatMapMarkets(markets, markets.map(({ id }) => id)).map(({ id }) => id),
    ["ZZZ", "AAA", "BBB", "CCC", "DDD"],
  );
});

test("heat map is a routed top-level view between assets and alerts", () => {
  assert.match(html, /data-tab="watchlist"[\s\S]*data-tab="heat-map"[\s\S]*data-tab="alerts"/);
  assert.match(html, /id="heat-map-view"[^>]*role="tabpanel"/);
  assert.match(html, /id="heat-map-grid"/);
  assert.match(app, /function renderHeatMap\(\)/);
  assert.match(app, /if \(view === "heat-map"\) renderHeatMap\(\)/);
  assert.match(app, /if \(route\.view === "heat-map"\) renderHeatMap\(\)/);
});
