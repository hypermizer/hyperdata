import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  fetchLiquidations,
  liquidationPath,
  LiquidationProviderError,
  normalizeLiquidationSnapshot,
} from "../liquidation-data.ts";
const fixture = () => ({
  snapshot_ts: new Date(Date.now() - 300_000).toISOString(),
  block_number: 1,
  mid_price: 100,
  total_long: 1000,
  total_short: 500,
  flagged_notional: 100,
  source: "raw",
  levels: [{
    price: 99,
    long_notional: 100,
    short_notional: 0,
    long_count: 2,
    short_count: 0,
  }],
});
Deno.test("liquidation identity preserves the venue and rejects paths or non-perpetual identifiers", () => {
  assertEquals(
    liquidationPath("BTC"),
    "/v1/hyperliquid/liquidations/BTC/levels",
  );
  assertEquals(
    liquidationPath("xyz:GOLD"),
    "/v1/hyperliquid/hip3/liquidations/xyz%3AGOLD/levels",
  );
  for (const asset of ["BTC/../ETH", "xyz:foo:BTC", "#0", "", "BTC?key=oops"]) {
    assertThrows(() => liquidationPath(asset));
  }
});
Deno.test("liquidation data fails closed on malformed prices, times, counts, and bucket resolution", () => {
  const f = fixture();
  assertEquals(normalizeLiquidationSnapshot(f).levels[0].long_notional, 100);
  for (const v of [NaN, Infinity, -1, null, "100"]) {
    assertThrows(() => normalizeLiquidationSnapshot({ ...f, mid_price: v }));
  }
  assertThrows(() =>
    normalizeLiquidationSnapshot({ ...f, snapshot_ts: "bad-time" })
  );
  assertThrows(() =>
    normalizeLiquidationSnapshot({
      ...f,
      levels: [{ ...f.levels[0], long_count: 0.5 }],
    })
  );
  assertThrows(() =>
    normalizeLiquidationSnapshot({ ...f, levels: [...f.levels, ...f.levels] })
  );
  const oldFormat = { ...f, snapshot_ts: "2026-08-05 14:03:07.000" };
  assertEquals(
    normalizeLiquidationSnapshot(oldFormat).snapshot_ts,
    "2026-08-05T14:03:07.000Z",
  );
});
Deno.test("upstream authentication stays in headers; mismatched markets and provider failures are rejected", async () => {
  let called = false;
  const result = await fetchLiquidations(
    "BTC",
    "test-private-key",
    {},
    (input, init) => {
      called = true;
      const u = new URL(String(input));
      assertEquals(u.searchParams.get("buckets"), "100");
      assertEquals(u.toString().includes("test-private-key"), false);
      assertEquals(
        (init?.headers as Record<string, string>)["X-API-Key"],
        "test-private-key",
      );
      return Promise.resolve(
        Response.json({
          success: true,
          data: fixture(),
          meta: { symbol: "BTC" },
        }, { headers: { "x-credits-remaining": "12345" } }),
      );
    },
  );
  assertEquals(called, true);
  assertEquals(result.creditsRemaining, 12345);
  await assertRejects(
    () =>
      fetchLiquidations("BTC", "key", {}, () =>
        Promise.resolve(
          Response.json({
            success: true,
            data: fixture(),
            meta: { symbol: "ETH" },
          }),
        )),
    Error,
    "another asset",
  );
  const e = await assertRejects(
    () =>
      fetchLiquidations("BTC", "key", {}, () =>
        Promise.resolve(
          Response.json(
            { success: false, error_code: "insufficient_credits" },
            { status: 429 },
          ),
        )),
    LiquidationProviderError,
  );
  assertEquals((e as LiquidationProviderError).code, "insufficient_credits");
});
