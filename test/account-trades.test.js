import assert from "node:assert/strict";
import test from "node:test";
import { accountSyncHealth, normalizeAccountFill } from "../public/lib/account-trades.js";

test("normalizes authoritative Hyperliquid fills for the trade log", () => {
  assert.deepEqual(normalizeAccountFill({
    trade_id: "123", asset: "xyz:DRAM", side: "sell", direction: "Close Long",
    size: "100", price: "51.492", closed_pnl: "22.5", fee: "0.1", fee_token: "USDC",
    occurred_at: "2026-08-04T17:13:00Z", order_id: "456", transaction_hash: "0xabc",
  }), {
    tradeId: "123", asset: "xyz:DRAM", side: "sell", direction: "Close Long",
    size: 100, price: 51.492, value: 5149.2, closedPnl: 22.5, fee: 0.1, feeToken: "USDC",
    occurredAt: "2026-08-04T17:13:00Z", orderId: "456", transactionHash: "0xabc",
  });
});

test("sync health distinguishes current, stale, never-run, and failed sources", () => {
  const now = Date.parse("2026-08-04T17:20:00Z");
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:19:20Z", last_error: null }, now), { label: "LIVE · 40S AGO", tone: "live" });
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:10:00Z", last_error: null }, now), { label: "STALE · 10M AGO", tone: "warning" });
  assert.deepEqual(accountSyncHealth({ last_success_at: null, last_error: null }, now), { label: "AWAITING FIRST SYNC", tone: "warning" });
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:19:20Z", last_error: "rate limited" }, now), { label: "SYNC ERROR · RATE LIMITED", tone: "error" });
});
