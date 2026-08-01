import assert from "node:assert/strict";
import test from "node:test";
import { fetchAssetNews } from "../public/lib/news.js";

test("fetchAssetNews returns normalized linked stories", async () => {
  const calls = [];
  const client = { functions: { invoke: async (name, options) => {
    calls.push({ name, options });
    return { data: { items: [{ title: "Oracle reports earnings", url: "https://example.com/story", source: "Example", publishedAt: "2026-07-31T12:00:00Z" }] }, error: null };
  } } };

  const items = await fetchAssetNews(client, "xyz:ORCL");
  assert.deepEqual(calls, [{ name: "asset-news", options: { body: { asset: "xyz:ORCL" } } }]);
  assert.deepEqual(items, [{ title: "Oracle reports earnings", url: "https://example.com/story", source: "Example", publishedAt: "2026-07-31T12:00:00.000Z", topic: "MARKET", score: null }]);
});

test("fetchAssetNews rejects malformed or failed responses", async () => {
  await assert.rejects(() => fetchAssetNews(null, "xyz:XYZ100"), /unavailable/i);
  await assert.rejects(() => fetchAssetNews({ functions: { invoke: async () => ({ data: null, error: new Error("down") }) } }, "xyz:DRAM"), /down/);
});
