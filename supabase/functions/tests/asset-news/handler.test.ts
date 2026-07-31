import { assertEquals } from "@std/assert";
import { handleAssetNews } from "../../asset-news/handler.ts";

const allowedOrigin = "https://hypermizer.github.io";

Deno.test("asset news validates origin and asset then returns stories", async () => {
  const response = await handleAssetNews(new Request("https://example.test", {
    method: "POST",
    headers: { origin: allowedOrigin, "content-type": "application/json" },
    body: JSON.stringify({ asset: "xyz:ORCL" }),
  }), { allowedOrigin, fetchNews: async () => [{ title: "Story", url: "https://example.com", source: "Example", publishedAt: "2026-07-31T12:00:00.000Z" }] });
  assertEquals(response.status, 200);
  assertEquals((await response.json()).items.length, 1);
});

Deno.test("asset news rejects foreign origins and invalid assets", async () => {
  const forbidden = await handleAssetNews(new Request("https://example.test", { method: "POST", headers: { origin: "https://evil.example" } }), { allowedOrigin, fetchNews: async () => [] });
  assertEquals(forbidden.status, 403);
  const invalid = await handleAssetNews(new Request("https://example.test", { method: "POST", headers: { origin: allowedOrigin, "content-type": "application/json" }, body: JSON.stringify({ asset: "../secret" }) }), { allowedOrigin, fetchNews: async () => [] });
  assertEquals(invalid.status, 400);
  const oversized = await handleAssetNews(new Request("https://example.test", { method: "POST", headers: { origin: allowedOrigin }, body: "x".repeat(257) }), { allowedOrigin, fetchNews: async () => [] });
  assertEquals(oversized.status, 413);
});
