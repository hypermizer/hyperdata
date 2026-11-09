import { assertEquals } from "@std/assert";
import { AlertStore } from "../store.ts";
import { LiquidationStore } from "../liquidation-store.ts";
import { collectLiquidations } from "../liquidation-collector.ts";
import {
  LiquidationProviderError,
  normalizeLiquidationSnapshot,
} from "../liquidation-data.ts";

Deno.test("liquidation demand, cache, cursors, credit pauses and concurrency limits persist independently", async () => {
  const db = new AlertStore({
    host: Deno.env.get("TEST_PGHOST"),
    port: Number(Deno.env.get("TEST_PGPORT") ?? 5546),
    user: Deno.env.get("TEST_PGUSER"),
    database: "postgres",
  });
  try {
    await db.migrate();
    await db.migrate(
      new URL("../migrations/002_liquidations.sql", import.meta.url),
    );
    await db
      .sql`truncate liquidation_snapshots,liquidation_requests,liquidation_fetch_log restart identity`;
    await db
      .sql`update liquidation_provider_state set cooldown_until=null,status='ready' where id`;
    const store = new LiquidationStore(db.sql);
    assertEquals(await store.watch("BTC", true), true);
    assertEquals(await store.watch("xyz:GOLD"), true);
    let calls = 0;
    const snapshot = normalizeLiquidationSnapshot({
      snapshot_ts: new Date(Date.now() - 300000).toISOString(),
      block_number: 100,
      mid_price: 100,
      total_long: 100,
      total_short: 0,
      flagged_notional: 10,
      source: "raw",
      levels: [{
        price: 99,
        long_notional: 100,
        short_notional: 0,
        long_count: 1,
        short_count: 0,
      }],
    });
    const fetcher = () => {
      calls++;
      return Promise.resolve({
        snapshots: [snapshot],
        next: null,
        creditsRemaining: 10000,
        creditsReset: null,
      });
    };
    await collectLiquidations(db, "test-key", fetcher);
    await collectLiquidations(db, "test-key", fetcher);
    await collectLiquidations(db, "test-key", fetcher);
    assertEquals(calls, 3); // BTC, GOLD, and a single BTC history page; no repeated latest calls.
    const read = await store.read("BTC", true);
    assertEquals(read.history.length, 1);
    assertEquals(read.request.history_complete, true);
    assertEquals(read.latest.source, "raw");
    await store.save("BTC", [{ ...snapshot, source: "unknown" }]);
    assertEquals((await store.read("BTC")).latest.source, "raw");
    await db
      .sql`update liquidation_requests set next_fetch_at=now()-interval '1 second' where asset='BTC'`;
    await collectLiquidations(db, "test-key", () => {
      calls++;
      return Promise.reject(
        new LiquidationProviderError(429, "insufficient_credits"),
      );
    });
    const before = calls;
    await collectLiquidations(db, "test-key", fetcher);
    assertEquals(calls, before);
    const paused = await store.read("BTC");
    assertEquals(paused.provider.status, "credits_exhausted");
    assertEquals(paused.latest.mid_price, 100);
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) => store.watch("ASSET" + i)),
    );
    assertEquals(results.filter(Boolean).length, 6);
    assertEquals(await store.watch("BTC"), true);
    await db
      .sql`update liquidation_provider_state set cooldown_until=null,status='ready' where id`;
    await db
      .sql`insert into liquidation_fetch_log(asset,kind) select 'BTC','latest' from generate_series(1,200)`;
    await collectLiquidations(db, "test-key", fetcher);
    assertEquals(calls, before);
    assertEquals((await store.read("BTC")).provider.status, "request_budget");
  } finally {
    await db.close();
  }
});
