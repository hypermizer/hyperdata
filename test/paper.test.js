import test from "node:test";
import assert from "node:assert/strict";
import { activePaperEpoch, formatPaperNumber, normalizeAccountName, normalizePaperOrder, normalizeStartingCapital, paperSignClass } from "../public/lib/paper.js";

test("paper account and order inputs normalize without binary calculations", () => {
  assert.equal(normalizeAccountName("  Mean   Reversion "), "Mean Reversion");
  assert.equal(normalizeStartingCapital("12500.50"), "12500.50");
  assert.throws(() => normalizeStartingCapital("0"), /positive/);
  assert.deepEqual(normalizePaperOrder({ asset: "xyz:ORCL", side: "buy", size: "1.25", orderType: "limit", timeInForce: "GTC", limitPrice: "100", triggerPrice: "", leverage: "5", marginMode: "isolated", reduceOnly: true }), {
    asset: "xyz:ORCL", side: "buy", size: "1.25", orderType: "limit", timeInForce: "GTC",
    limitPrice: "100", triggerPrice: null, leverage: 5, marginMode: "isolated", reduceOnly: true,
  });
  assert.throws(() => normalizePaperOrder({ asset: "ORCL", side: "buy", size: "0", orderType: "market", leverage: 1, marginMode: "cross" }), /positive/);
  assert.throws(() => normalizePaperOrder({ asset: "ORCL", side: "buy", size: "1", orderType: "stop_market", leverage: 1, marginMode: "cross" }), /Trigger/);
  assert.throws(() => normalizePaperOrder({ asset: "DRAM", side: "buy", size: "1", orderType: "market", leverage: 21, marginMode: "cross" }, 20), /maximum.*20/i);
  assert.equal(normalizePaperOrder({ asset: "DRAM", side: "buy", size: "1", orderType: "market", leverage: 20, marginMode: "cross" }, 20).leverage, 20);
});

test("paper projection helpers are deterministic", () => {
  assert.equal(formatPaperNumber("1234.567", 2), "1,234.57");
  assert.equal(paperSignClass("-1"), "negative");
  assert.equal(activePaperEpoch({ id: "a", active_epoch: 2 }, [{ id: "old", account_id: "a", epoch_number: 1, state: "closed" }, { id: "new", account_id: "a", epoch_number: 2, state: "active" }]).id, "new");
});
