import assert from "node:assert/strict";
import test from "node:test";
import { buildTradeLedger, normalizeTradeOrder } from "../public/lib/trade-log.js";

const order = (id, asset, side, shares, price, executedAt) => ({
  id,
  asset,
  side,
  shares,
  price,
  executed_at: executedAt,
  created_at: executedAt,
});

test("a position remains open through buys and partial sells until its shares reach zero", () => {
  const ledger = buildTradeLedger([
    order("1", "xyz:DRAM", "buy", 100, 50, "2026-08-01T10:00:00Z"),
    order("2", "xyz:DRAM", "buy", 25, 48, "2026-08-02T10:00:00Z"),
    order("3", "xyz:DRAM", "sell", 50, 55, "2026-08-03T10:00:00Z"),
    order("4", "xyz:DRAM", "sell", 75, 56, "2026-08-04T10:00:00Z"),
  ]);

  assert.deepEqual(ledger.map(({ positionNumber, sharesAfter, status }) => ({ positionNumber, sharesAfter, status })), [
    { positionNumber: 1, sharesAfter: 100, status: "open" },
    { positionNumber: 1, sharesAfter: 125, status: "open" },
    { positionNumber: 1, sharesAfter: 75, status: "open" },
    { positionNumber: 1, sharesAfter: 0, status: "closed" },
  ]);
});

test("a later buy after a full exit starts a new position cycle for the asset", () => {
  const ledger = buildTradeLedger([
    order("1", "BTC", "buy", 1, 100_000, "2026-08-01T10:00:00Z"),
    order("2", "BTC", "sell", 1, 101_000, "2026-08-01T11:00:00Z"),
    order("3", "BTC", "buy", 0.5, 99_000, "2026-08-03T10:00:00Z"),
  ]);

  assert.deepEqual(ledger.map(({ positionNumber, status }) => ({ positionNumber, status })), [
    { positionNumber: 1, status: "open" },
    { positionNumber: 1, status: "closed" },
    { positionNumber: 2, status: "open" },
  ]);
});

test("orders are evaluated chronologically even when loaded newest first", () => {
  const ledger = buildTradeLedger([
    order("2", "ORCL", "sell", 5, 151, "2026-08-02T10:00:00Z"),
    order("1", "ORCL", "buy", 10, 150, "2026-08-01T10:00:00Z"),
  ]);

  assert.deepEqual(ledger.map(({ id, sharesAfter }) => ({ id, sharesAfter })), [
    { id: "1", sharesAfter: 10 },
    { id: "2", sharesAfter: 5 },
  ]);
});

test("selling more shares than are held is rejected", () => {
  assert.throws(() => buildTradeLedger([
    order("1", "ORCL", "buy", 10, 150, "2026-08-01T10:00:00Z"),
    order("2", "ORCL", "sell", 10.01, 151, "2026-08-02T10:00:00Z"),
  ]), /exceeds the 10 shares held/i);
});

test("trade input normalization enforces positive finite values and canonical fields", () => {
  assert.deepEqual(normalizeTradeOrder({
    asset: " xyz:dram ", side: "BUY", shares: "2.5", price: "51.25", executedAt: "2026-08-04T12:30",
  }), {
    asset: "xyz:DRAM",
    side: "buy",
    shares: 2.5,
    price: 51.25,
    executedAt: "2026-08-04T12:30:00.000Z",
    note: "",
  });
  assert.throws(() => normalizeTradeOrder({ asset: "BTC", side: "buy", shares: 0, price: 1, executedAt: "2026-08-04" }), /shares must be positive/i);
  assert.throws(() => normalizeTradeOrder({ asset: "BTC", side: "hold", shares: 1, price: 1, executedAt: "2026-08-04" }), /side must be buy or sell/i);
});
