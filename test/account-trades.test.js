import assert from "node:assert/strict";
import test from "node:test";
import { accountSyncHealth, buildPositionEpisodes, formatTradeTimestamp, normalizeAccountFill } from "../public/lib/account-trades.js";

test("normalizes authoritative Hyperliquid fills for the trade log", () => {
  assert.deepEqual(normalizeAccountFill({
    trade_id: "123", asset: "xyz:DRAM", side: "sell", direction: "Close Long",
    size: "100", price: "51.492", closed_pnl: "22.5", fee: "0.1", fee_token: "USDC",
    start_position: "100", occurred_at: "2026-08-04T17:13:00Z", order_id: "456", transaction_hash: "0xabc",
  }), {
    tradeId: "123", asset: "xyz:DRAM", side: "sell", direction: "Close Long",
    size: 100, price: 51.492, value: 5149.2, closedPnl: 22.5, fee: 0.1, feeToken: "USDC",
    startPosition: 100, occurredAt: "2026-08-04T17:13:00Z", orderId: "456", transactionHash: "0xabc",
  });
});

function fill(tradeId, asset, side, size, startPosition, occurredAt, extras = {}) {
  return normalizeAccountFill({
    trade_id: tradeId, asset, side, direction: extras.direction ?? (side === "sell" ? "Open Short" : "Open Long"),
    size, price: extras.price ?? "100", start_position: startPosition, closed_pnl: extras.closedPnl ?? "0",
    fee: extras.fee ?? "0.1", occurred_at: occurredAt, order_id: tradeId,
  });
}

test("groups scale-ins and exits beneath one directional position root", () => {
  const episodes = buildPositionEpisodes([
    fill("1", "xyz:PLTR", "sell", "2", "0", "2026-08-04T10:00:00Z"),
    fill("2", "xyz:PLTR", "sell", "3", "-2", "2026-08-04T10:05:00Z"),
    fill("3", "xyz:PLTR", "buy", "1", "-5", "2026-08-04T11:00:00Z", { direction: "Close Short", closedPnl: "5" }),
    fill("4", "xyz:PLTR", "buy", "4", "-4", "2026-08-04T12:00:00Z", { direction: "Close Short", closedPnl: "12" }),
  ]);

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].label, "SHORT PLTR");
  assert.equal(episodes[0].positionKey, "xyz:PLTR|short|1");
  assert.equal(episodes[0].status, "closed");
  assert.equal(episodes[0].fills.length, 4);
  assert.equal(episodes[0].closedPnl, 17);
  assert.equal(episodes[0].currentSize, 0);
});

test("creates new roots after a close and keeps assets independent", () => {
  const episodes = buildPositionEpisodes([
    fill("1", "xyz:PLTR", "sell", "2", "0", "2026-08-04T10:00:00Z"),
    fill("b1", "BTC", "buy", "0.1", "0", "2026-08-04T10:01:00Z"),
    fill("2", "xyz:PLTR", "buy", "2", "-2", "2026-08-04T10:02:00Z", { direction: "Close Short" }),
    fill("3", "xyz:PLTR", "buy", "1", "0", "2026-08-04T10:03:00Z"),
  ]);

  assert.deepEqual(episodes.map(({ label, status }) => [label, status]), [
    ["LONG PLTR", "open"], ["SHORT PLTR", "closed"], ["LONG BTC", "open"],
  ]);
});

test("splits a direction-flipping fill between the closing and opening roots", () => {
  const episodes = buildPositionEpisodes([
    fill("1", "xyz:PLTR", "buy", "2", "0", "2026-08-04T10:00:00Z"),
    fill("2", "xyz:PLTR", "sell", "5", "2", "2026-08-04T10:05:00Z", { direction: "Long > Short", fee: "0.5", closedPnl: "10" }),
  ]);

  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].label, "SHORT PLTR");
  assert.equal(episodes[0].fills[0].size, 3);
  assert.equal(episodes[1].label, "LONG PLTR");
  assert.equal(episodes[1].fills[1].size, 2);
  assert.equal(episodes[1].status, "closed");
});

test("formats trade times without seconds", () => {
  assert.equal(formatTradeTimestamp("2026-08-04T17:13:59Z", "UTC"), "08/04/26 5:13PM");
});

test("sync health distinguishes current, stale, never-run, and failed sources", () => {
  const now = Date.parse("2026-08-04T17:20:00Z");
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:19:20Z", last_error: null }, now), { label: "LIVE · 40S AGO", tone: "live" });
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:10:00Z", last_error: null }, now), { label: "STALE · 10M AGO", tone: "warning" });
  assert.deepEqual(accountSyncHealth({ last_success_at: null, last_error: null }, now), { label: "AWAITING FIRST SYNC", tone: "warning" });
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:19:20Z", last_error: "rate limited" }, now), { label: "SYNC ERROR · RATE LIMITED", tone: "error" });
});
