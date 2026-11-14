import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeFor } from "../public/lib/routes.js";

test("site routes resolve top-level and nested utility views", () => {
  assert.deepEqual(parseRoute("#/compare"), { view: "compare", analysisView: "trade-log", paperView: "home" });
  assert.equal(routeFor("compare"), "#/compare");
  assert.deepEqual(parseRoute("#/heat-map"), { view: "charts", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/alerts"), { view: "alerts", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/analysis"), { view: "analysis", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/analysis/trade-log"), { view: "analysis", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/principles"), { view: "principles", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/paper/order"), { view: "paper", analysisView: "trade-log", paperView: "order" });
  assert.deepEqual(parseRoute("#/paper"), { view: "paper", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/tools/exposure-ladder"), { view: "watchlist", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/tools/scaling"), { view: "watchlist", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/tools/levels"), { view: "watchlist", analysisView: "trade-log", paperView: "home" });
});

test("asset routes preserve the canonical Hyperliquid asset id", () => {
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM"), {
    view: "asset",
    asset: "xyz:DRAM",
    assetView: "overview",
    interval: "1h",
    analysisView: "trade-log",
    paperView: "home",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/5m"), {
    view: "asset",
    asset: "xyz:DRAM",
    assetView: "overview",
    interval: "5m",
    analysisView: "trade-log",
    paperView: "home",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/news"), {
    view: "asset", asset: "xyz:DRAM", assetView: "news", interval: "1h", analysisView: "trade-log", paperView: "home",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/financials"), {
    view: "asset", asset: "xyz:DRAM", assetView: "financials", interval: "1h", analysisView: "trade-log", paperView: "home",
  });
  assert.equal(routeFor("asset", "xyz:DRAM"), "#/assets/xyz%3ADRAM/overview/1h");
  assert.equal(routeFor("asset", "xyz:DRAM", "1d"), "#/assets/xyz%3ADRAM/overview/1d");
  assert.equal(routeFor("asset", "xyz:DRAM", "news"), "#/assets/xyz%3ADRAM/news");
  assert.equal(routeFor("asset", "xyz:DRAM", "overview", "5m"), "#/assets/xyz%3ADRAM/overview/5m");
  assert.deepEqual(parseRoute("#/assets"), {
    view: "watchlist",
    analysisView: "trade-log",
    paperView: "home",
  });
});

test("unknown routes fall back to the watchlist", () => {
  assert.deepEqual(parseRoute(""), { view: "watchlist", analysisView: "trade-log", paperView: "home" });
  assert.deepEqual(parseRoute("#/missing"), { view: "watchlist", analysisView: "trade-log", paperView: "home" });
  assert.equal(routeFor("paper", "order"), "#/paper/order");
  assert.equal(routeFor("watchlist"), "#/watchlist");
  assert.equal(routeFor("heat-map"), "#/charts");
  assert.equal(routeFor("analysis"), "#/analysis/trade-log");
  assert.equal(routeFor("principles"), "#/principles");
  assert.equal(routeFor("tools", "home", "exposure-ladder"), "#/watchlist");
  assert.equal(routeFor("tools", "home", "scaling"), "#/watchlist");
});
