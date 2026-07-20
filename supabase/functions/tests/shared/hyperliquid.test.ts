import { assertEquals } from "@std/assert";
import { assertPublicHyperliquidUrl, fetchMarketBatches, infoRequest, normalizeDexContext } from "../../_shared/hyperliquid.ts";
const payload = [{ universe: [{ name: "xyz:ORCL" }] }, [{ markPx: "100", oraclePx: "99.9", midPx: "100.1", openInterest: "12", dayNtlVlm: "500" }]];
Deno.test("normalizes a HIP-3 context", () => {
  const [row] = normalizeDexContext("xyz", payload, new Set(["xyz:ORCL"]), new Date("2026-01-01T00:00:00Z"));
  assertEquals(row.asset, "xyz:ORCL"); assertEquals(row.mark_price, 100); assertEquals(row.dex, "xyz");
});
Deno.test("deduplicates assets and batches once per DEX", async () => {
  let calls = 0; const mock = async () => { calls += 1; return new Response(JSON.stringify(payload)); };
  const results = await fetchMarketBatches([{ asset: "xyz:ORCL", dex: "xyz" }, { asset: "xyz:ORCL", dex: "xyz" }], new Date(), mock as typeof fetch, 0);
  assertEquals(calls, 1); assertEquals(results.get("xyz")?.ok, true);
});
Deno.test("isolates exhausted 429 failures", async () => {
  const mock = async () => new Response("rate", { status: 429 });
  const results = await fetchMarketBatches([{ asset: "xyz:ORCL", dex: "xyz" }], new Date(), mock as typeof fetch, 0);
  assertEquals(results.get("xyz")?.ok, false);
});
Deno.test("rejects an invalid asset without discarding valid DEX peers", () => {
  const mixed = [{ universe: [{ name: "xyz:ORCL" }, { name: "xyz:BAD" }] }, [{ markPx: "100" }, { markPx: "0" }]];
  const rows = normalizeDexContext("xyz", mixed, new Set(["xyz:ORCL", "xyz:BAD"]), new Date());
  assertEquals(rows.map((row) => row.asset), ["xyz:ORCL"]);
});
Deno.test("generic info requests remain pinned to the public info endpoint", async () => {
  let body = "";
  const mock = async (_url: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ ok: true }));
  };
  await infoRequest({ type: "l2Book", coin: "xyz:ORCL" }, mock as typeof fetch, 0);
  assertEquals(JSON.parse(body), { type: "l2Book", coin: "xyz:ORCL" });
  assertEquals(assertPublicHyperliquidUrl("https://api.hyperliquid.xyz/info"), true);
  assertEquals(assertPublicHyperliquidUrl("https://api.hyperliquid.xyz/exchange"), false);
  assertEquals(assertPublicHyperliquidUrl("https://evil.example/info"), false);
});
