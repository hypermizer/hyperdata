import assert from "node:assert/strict";
import test from "node:test";
import { accountSyncHealth, aggregateEpisodeOrders, buildPositionEpisodes, fetchAllAccountFills, formatTradeTimestamp, normalizeAccountFill } from "../public/lib/account-trades.js";

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
  assert.equal(episodes[0].fills[0].direction, "Open short");
  assert.equal(episodes[1].label, "LONG PLTR");
  assert.equal(episodes[1].fills[1].size, 2);
  assert.equal(episodes[1].fills[1].direction, "Close long");
  assert.equal(episodes[1].status, "closed");

  const shortOrder = aggregateEpisodeOrders(episodes[0])[0];
  const longCloseOrder = aggregateEpisodeOrders(episodes[1]).at(-1);
  assert.deepEqual(
    [shortOrder.size, shortOrder.episodeSize, shortOrder.direction],
    [5, 3, "Open short"],
  );
  assert.equal(shortOrder.closedPnl, 0);
  assert.equal(shortOrder.fee, 0.3);
  assert.deepEqual(
    [longCloseOrder.size, longCloseOrder.episodeSize, longCloseOrder.direction],
    [5, 2, "Close long"],
  );
  assert.equal(longCloseOrder.closedPnl, 10);
  assert.equal(longCloseOrder.fee, 0.2);
});

test("same-timestamp fill fragments follow start-position sequence instead of trade id", () => {
  const closeTime = "2026-08-05T16:00:44.406Z";
  const episodes = buildPositionEpisodes([
    fill("1", "xyz:DRAM", "sell", "171.1", "0", "2026-08-05T15:10:43.959Z"),
    fill("107173365102331", "xyz:DRAM", "buy", "54.2", "-171.1", closeTime, { direction: "Close Short" }),
    fill("220600984158807", "xyz:DRAM", "buy", "23.7", "-116.9", closeTime, { direction: "Close Short" }),
    fill("345028357064587", "xyz:DRAM", "buy", "1.8", "-93.2", closeTime, { direction: "Close Short" }),
    fill("1076203989373845", "xyz:DRAM", "buy", "54.2", "-91.4", closeTime, { direction: "Close Short" }),
    fill("826988671707453", "xyz:DRAM", "buy", "29.2", "-37.2", closeTime, { direction: "Close Short" }),
    fill("1071885684946000", "xyz:DRAM", "buy", "8", "-8", closeTime, { direction: "Close Short" }),
    fill("9", "xyz:DRAM", "sell", "20", "0", "2026-08-05T16:01:09.199Z"),
    fill("10", "xyz:DRAM", "sell", "20", "-20", "2026-08-05T16:08:59.933Z"),
  ]);

  assert.equal(episodes[0].status, "open");
  assert.equal(episodes[0].currentSize, 40);
  assert.deepEqual(episodes[0].fills.map(({ direction }) => direction), ["Open Short", "Open Short"]);
  assert.equal(episodes[1].status, "closed");
  assert.equal(episodes[1].currentSize, 0);
});

test("same-timestamp opposite-side orders follow their position chain", () => {
  const time = "2026-08-05T16:00:44.406Z";
  const episodes = buildPositionEpisodes([
    fill("1", "xyz:DRAM", "sell", "10", "0", "2026-08-05T16:00:00Z"),
    { ...fill("2", "xyz:DRAM", "sell", "3", "-5", time), orderId: "20" },
    { ...fill("9", "xyz:DRAM", "buy", "5", "-10", time, { direction: "Close Short" }), orderId: "10" },
  ]);

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].status, "open");
  assert.equal(episodes[0].currentSize, 8);
  assert.deepEqual(episodes[0].fills.map(({ startPosition }) => startPosition), [0, -10, -5]);
});

test("aggregates exchange fill fragments into one submitted-order row", () => {
  const orderTime = "2026-08-05T16:08:59.933Z";
  const episode = buildPositionEpisodes([
    fill("1", "xyz:DRAM", "sell", "1.8", "0", orderTime, { price: "54.609" }),
    { ...fill("2", "xyz:DRAM", "sell", "2.9", "-1.8", orderTime, { price: "54.605" }), orderId: "1" },
    { ...fill("3", "xyz:DRAM", "sell", "15.3", "-4.7", orderTime, { price: "54.604" }), orderId: "1" },
  ])[0];
  const orders = aggregateEpisodeOrders(episode);

  assert.equal(orders.length, 1);
  assert.equal(orders[0].size, 20);
  assert.equal(orders[0].fillCount, 3);
  assert.equal(orders[0].direction, "Open Short");
  assert.ok(Math.abs(orders[0].price - 54.604595) < 1e-8);
});

test("formats trade times without seconds", () => {
  assert.equal(formatTradeTimestamp("2026-08-04T17:13:59Z", "UTC"), "08/04/26 5:13PM");
});

test("loads every fill in deterministic bounded pages", async () => {
  const calls = [];
  const result = await fetchAllAccountFills(async (from, to) => {
    calls.push([from, to]);
    return { data: from === 0 ? [{ trade_id: "1" }, { trade_id: "2" }] : [{ trade_id: "3" }], error: null };
  }, 2);

  assert.deepEqual(calls, [[0, 1], [2, 3]]);
  assert.deepEqual(result, { data: [{ trade_id: "1" }, { trade_id: "2" }, { trade_id: "3" }], error: null });
});

test("stops fill pagination on the first failed page", async () => {
  const failure = new Error("query failed");
  const result = await fetchAllAccountFills(async (from) => (
    from === 0 ? { data: [{ trade_id: "1" }], error: null } : { data: null, error: failure }
  ), 1);
  assert.deepEqual(result, { data: null, error: failure });
});

test("sync health distinguishes current, stale, never-run, and failed sources", () => {
  const now = Date.parse("2026-08-04T17:20:00Z");
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:19:20Z", last_error: null }, now), { label: "LIVE · 40S AGO", tone: "live" });
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:10:00Z", last_error: null }, now), { label: "STALE · 10M AGO", tone: "warning" });
  assert.deepEqual(accountSyncHealth({ last_success_at: null, last_error: null }, now), { label: "AWAITING FIRST SYNC", tone: "warning" });
  assert.deepEqual(accountSyncHealth({ last_success_at: "2026-08-04T17:19:20Z", last_error: "rate limited" }, now), { label: "SYNC ERROR · RATE LIMITED", tone: "error" });
});
