import test from "node:test";
import assert from "node:assert/strict";
import {
  analyticsCacheUrl,
  analyticsShardAssets,
  collectMarketCatalogResults,
} from "../scripts/lib/asset-analytics-refresh.js";

test("analytics refresh preserves a healthy DEX catalog after its peer fails", () => {
  const { markets, failures } = collectMarketCatalogResults([
    { status: "rejected", reason: new Error("native unavailable") },
    { status: "fulfilled", value: [{ id: "xyz:ORCL" }] },
  ]);
  assert.deepEqual(markets, [{ id: "xyz:ORCL" }]);
  assert.deepEqual(failures, ["native: native unavailable"]);
});

test("analytics refresh deduplicates assets and scopes cache reads to its shard", () => {
  const { assets, shardAssets } = analyticsShardAssets([
    { id: "BTC" },
    { id: "BTC" },
    { id: "ETH" },
    { id: "xyz:ORCL" },
    { id: "DELISTED", isDelisted: true },
  ], 1, 2);
  assert.deepEqual(assets, ["BTC", "ETH", "xyz:ORCL"]);
  assert.deepEqual(shardAssets, ["ETH"]);
  const url = analyticsCacheUrl("https://example.supabase.co/rest/v1/asset_analytics_cache", shardAssets);
  assert.equal(url.searchParams.get("asset"), "in.(ETH)");
});
