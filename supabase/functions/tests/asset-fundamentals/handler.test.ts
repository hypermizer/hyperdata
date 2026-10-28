import { assertEquals } from "@std/assert";
import { handleAssetFundamentals } from "../../asset-fundamentals/handler.ts";

const allowedOrigin = "https://hypermizer.github.io";

Deno.test("asset fundamentals validates requests and returns financial data", async () => {
  const response = await handleAssetFundamentals(new Request("https://example.test", {
    method: "POST", headers: { origin: allowedOrigin }, body: JSON.stringify({ asset: "xyz:ORCL" }),
  }), { allowedOrigin, fetchFundamentals: async () => ({ identity: { displayName: "Oracle" }, available: true } as never) });
  assertEquals(response.status, 200);
  assertEquals((await response.json()).available, true);
});

Deno.test("asset fundamentals rejects invalid assets and origins", async () => {
  const fetchFundamentals = async () => ({} as never);
  const forbidden = await handleAssetFundamentals(new Request("https://example.test", { method: "POST", headers: { origin: "https://evil.test" } }), { allowedOrigin, fetchFundamentals });
  assertEquals(forbidden.status, 403);
  const invalid = await handleAssetFundamentals(new Request("https://example.test", { method: "POST", headers: { origin: allowedOrigin }, body: JSON.stringify({ asset: "../bad" }) }), { allowedOrigin, fetchFundamentals });
  assertEquals(invalid.status, 400);
});

Deno.test("asset fundamentals accepts every canonical Hyperliquid provider", async () => {
  for (const asset of ["para:10Y", "mkts:USBOND", "io:ANTH", "BTC"]) {
    const response = await handleAssetFundamentals(new Request("https://example.test", {
      method: "POST", headers: { origin: allowedOrigin }, body: JSON.stringify({ asset }),
    }), { allowedOrigin, fetchFundamentals: async () => ({ identity: { displayName: asset }, available: false } as never) });
    assertEquals(response.status, 200);
  }
});
