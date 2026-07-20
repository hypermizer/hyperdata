import assert from "node:assert/strict";
import test from "node:test";
import { resolveAsset, searchAssets } from "../public/lib/assets.js";

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
