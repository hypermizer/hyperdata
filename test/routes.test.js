import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeFor } from "../public/lib/routes.js";

test("site routes resolve top-level and nested paper views", () => {
  assert.deepEqual(parseRoute("#/alerts"), { view: "alerts", paperView: "home" });
  assert.deepEqual(parseRoute("#/paper/order"), { view: "paper", paperView: "order" });
  assert.deepEqual(parseRoute("#/paper"), { view: "paper", paperView: "home" });
});

test("unknown routes fall back to the watchlist", () => {
  assert.deepEqual(parseRoute(""), { view: "watchlist", paperView: "home" });
  assert.deepEqual(parseRoute("#/missing"), { view: "watchlist", paperView: "home" });
  assert.equal(routeFor("paper", "order"), "#/paper/order");
  assert.equal(routeFor("watchlist"), "#/watchlist");
});
