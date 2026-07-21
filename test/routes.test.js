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

test("unknown routes fall back to the watchlist", () => {
  assert.deepEqual(parseRoute(""), { view: "watchlist", paperView: "home", toolsView: "exposure-ladder" });
  assert.deepEqual(parseRoute("#/missing"), { view: "watchlist", paperView: "home", toolsView: "exposure-ladder" });
  assert.equal(routeFor("paper", "order"), "#/paper/order");
  assert.equal(routeFor("watchlist"), "#/watchlist");
  assert.equal(routeFor("analysis"), "#/analysis");
  assert.equal(routeFor("strats"), "#/strats");
  assert.equal(routeFor("tools", "home", "exposure-ladder"), "#/tools/exposure-ladder");
});
