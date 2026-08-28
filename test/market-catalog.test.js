import test from "node:test";
import assert from "node:assert/strict";
import { requireAssetUniverseDexes } from "../public/lib/market-catalog.js";

test("asset catalog requires both native crypto and TradFi markets", () => {
  const complete = [{ id: "BTC", dexId: "" }, { id: "xyz:ORCL", dexId: "xyz" }];
  assert.equal(requireAssetUniverseDexes(complete), complete);
  assert.throws(
    () => requireAssetUniverseDexes([{ id: "BTC", dexId: "" }]),
    /TradFi catalog unavailable/,
  );
  assert.throws(
    () => requireAssetUniverseDexes([{ id: "xyz:ORCL", dexId: "xyz" }]),
    /native crypto catalog unavailable/,
  );
});
