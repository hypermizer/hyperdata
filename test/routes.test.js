import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeFor } from "../public/lib/routes.js";

test("site routes resolve top-level and nested paper views", () => {
  assert.deepEqual(parseRoute("#/alerts"), { view: "alerts", paperView: "home", toolsView: "exposure-ladder" });
  assert.deepEqual(parseRoute("#/analysis"), { view: "analysis", paperView: "home", toolsView: "exposure-ladder" });
  assert.deepEqual(parseRoute("#/paper/order"), { view: "paper", paperView: "order", toolsView: "exposure-ladder" });
  assert.deepEqual(parseRoute("#/paper"), { view: "paper", paperView: "home", toolsView: "exposure-ladder" });
  assert.deepEqual(parseRoute("#/strats"), { view: "strats", paperView: "home", toolsView: "exposure-ladder" });
  assert.deepEqual(parseRoute("#/tools/exposure-ladder"), { view: "tools", paperView: "home", toolsView: "exposure-ladder" });
});

test("asset routes preserve the canonical Hyperliquid asset id", () => {
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM"), {
    view: "asset",
    asset: "xyz:DRAM",
    assetView: "overview",
    interval: "1h",
    paperView: "home",
    toolsView: "exposure-ladder",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/5m"), {
    view: "asset",
    asset: "xyz:DRAM",
    assetView: "overview",
    interval: "5m",
    paperView: "home",
    toolsView: "exposure-ladder",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/news"), {
    view: "asset", asset: "xyz:DRAM", assetView: "news", interval: "1h", paperView: "home", toolsView: "exposure-ladder",
  });
  assert.deepEqual(parseRoute("#/assets/xyz%3ADRAM/financials"), {
    view: "asset", asset: "xyz:DRAM", assetView: "financials", interval: "1h", paperView: "home", toolsView: "exposure-ladder",
  });
  assert.equal(routeFor("asset", "xyz:DRAM"), "#/assets/xyz%3ADRAM/overview/1h");
  assert.equal(routeFor("asset", "xyz:DRAM", "1d"), "#/assets/xyz%3ADRAM/overview/1d");
  assert.equal(routeFor("asset", "xyz:DRAM", "news"), "#/assets/xyz%3ADRAM/news");
  assert.equal(routeFor("asset", "xyz:DRAM", "overview", "5m"), "#/assets/xyz%3ADRAM/overview/5m");
  assert.deepEqual(parseRoute("#/assets"), {
    view: "watchlist",
    paperView: "home",
    toolsView: "exposure-ladder",
  });
});

test("unknown routes fall back to the watchlist", () => {
  assert.deepEqual(parseRoute(""), { view: "watchlist", paperView: "home", toolsView: "exposure-ladder" });
  assert.deepEqual(parseRoute("#/missing"), { view: "watchlist", paperView: "home", toolsView: "exposure-ladder" });
  assert.equal(routeFor("paper", "order"), "#/paper/order");
  assert.equal(routeFor("watchlist"), "#/watchlist");
  assert.equal(routeFor("analysis"), "#/analysis");
  assert.equal(routeFor("strats"), "#/strats");
  assert.equal(routeFor("tools", "home", "exposure-ladder"), "#/tools/exposure-ladder");
});
