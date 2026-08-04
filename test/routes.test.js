import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeFor } from "../public/lib/routes.js";

test("site routes resolve top-level and nested utility views", () => {
  assert.deepEqual(parseRoute("#/alerts"), { view: "alerts", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/analysis"), { view: "analysis", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/analysis/trade-log"), { view: "analysis", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/principles"), { view: "principles", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/paper/order"), { view: "paper", analysisView: "trade-log", paperView: "order", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/paper"), { view: "paper", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/tools/exposure-ladder"), { view: "tools", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/tools/scaling"), { view: "tools", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/tools/levels"), { view: "tools", analysisView: "trade-log", paperView: "home", toolsView: "levels" });
});

test("asset routes preserve the canonical Hyperliquid asset id", () => {
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM"), {
    view: "asset",
    asset: "xyz:DRAM",
    assetView: "overview",
    interval: "1h",
    analysisView: "trade-log",
    paperView: "home",
    toolsView: "scaling",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/5m"), {
    view: "asset",
    asset: "xyz:DRAM",
    assetView: "overview",
    interval: "5m",
    analysisView: "trade-log",
    paperView: "home",
    toolsView: "scaling",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/news"), {
    view: "asset", asset: "xyz:DRAM", assetView: "news", interval: "1h", analysisView: "trade-log", paperView: "home", toolsView: "scaling",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/financials"), {
    view: "asset", asset: "xyz:DRAM", assetView: "financials", interval: "1h", analysisView: "trade-log", paperView: "home", toolsView: "scaling",
  });
  assert.equal(routeFor("asset", "xyz:DRAM"), "#/assets/xyz%3ADRAM/overview/1h");
  assert.equal(routeFor("asset", "xyz:DRAM", "1d"), "#/assets/xyz%3ADRAM/overview/1d");
  assert.equal(routeFor("asset", "xyz:DRAM", "news"), "#/assets/xyz%3ADRAM/news");
  assert.equal(routeFor("asset", "xyz:DRAM", "overview", "5m"), "#/assets/xyz%3ADRAM/overview/5m");
  assert.deepEqual(parseRoute("#/assets"), {
    view: "watchlist",
    analysisView: "trade-log",
    paperView: "home",
    toolsView: "scaling",
  });
});

test("unknown routes fall back to the watchlist", () => {
  assert.deepEqual(parseRoute(""), { view: "watchlist", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.deepEqual(parseRoute("#/missing"), { view: "watchlist", analysisView: "trade-log", paperView: "home", toolsView: "scaling" });
  assert.equal(routeFor("paper", "order"), "#/paper/order");
  assert.equal(routeFor("watchlist"), "#/watchlist");
  assert.equal(routeFor("analysis"), "#/analysis/trade-log");
  assert.equal(routeFor("principles"), "#/principles");
  assert.equal(routeFor("tools", "home", "exposure-ladder"), "#/tools/scaling");
  assert.equal(routeFor("tools", "home", "scaling"), "#/tools/scaling");
});
