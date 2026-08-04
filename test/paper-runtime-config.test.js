import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production runtime does not seed synthetic paper or strategy workloads", async () => {
  const source = await readFile(new URL("../scripts/configure-supabase-runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ensure_paper_shadow_account/);
  assert.doesNotMatch(source, /ensure_strategy_shadow/);
  assert.doesNotMatch(source, /ensure_initial_strategy_backtest/);
  assert.match(source, /stale_positions/);
  assert.match(source, /inconsistent_accounts/);
});

test("production deployment verifies a completed account sync and disables a failed schedule", async () => {
  const source = await readFile(new URL("../scripts/configure-supabase-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /hyperliquid_account_sources/);
  assert.match(source, /hyperliquid_account_fills/);
  assert.match(source, /Account sync health verified/);
  assert.match(source, /cron\.unschedule\(jobid\).*hyperdata-sync-account/s);
});
