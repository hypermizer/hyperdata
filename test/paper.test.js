import test from "node:test";
import assert from "node:assert/strict";
import {
  activePaperEpoch,
  estimateIsolatedLiquidationPrice,
  estimateMarketFill,
  formatPaperNumber,
  normalizeAccountName,
  normalizePaperFeeSchedule,
  normalizePaperOrder,
  normalizeStartingCapital,
  paperFeeRates,
  paperOrderPreview,
  paperSignClass,
} from "../public/lib/paper.js";

test("paper account and order inputs normalize without binary calculations", () => {
  assert.equal(normalizeAccountName("  Mean   Reversion "), "Mean Reversion");
  assert.equal(normalizeStartingCapital("12500.50"), "12500.50");
  assert.throws(() => normalizeStartingCapital("0"), /positive/);
  assert.deepEqual(normalizePaperOrder({ asset: "xyz:ORCL", side: "buy", size: "1.25", orderType: "limit", timeInForce: "GTC", limitPrice: "100", triggerPrice: "", leverage: "5", marginMode: "isolated", reduceOnly: true }), {
    asset: "xyz:ORCL", side: "buy", size: "1.25", orderType: "limit", timeInForce: "GTC",
    limitPrice: "100", triggerPrice: null, leverage: 5, marginMode: "isolated", reduceOnly: true,
  });
  assert.throws(() => normalizePaperOrder({ asset: "ORCL", side: "buy", size: "0", orderType: "market", leverage: 1, marginMode: "cross" }), /greater than 0 shares/i);
  assert.throws(() => normalizePaperOrder({ asset: "ORCL", side: "buy", size: "1", orderType: "stop_market", leverage: 1, marginMode: "cross" }), /Trigger/);
  assert.throws(() => normalizePaperOrder({ asset: "DRAM", side: "buy", size: "1", orderType: "market", leverage: 21, marginMode: "cross" }, 20), /maximum.*20/i);
  assert.equal(normalizePaperOrder({ asset: "DRAM", side: "buy", size: "1", orderType: "market", leverage: 20, marginMode: "cross" }, 20).leverage, 20);
});

test("paper projection helpers are deterministic", () => {
  assert.equal(formatPaperNumber("1234.567", 2), "1,234.57");
  assert.equal(paperSignClass("-1"), "negative");
  assert.equal(activePaperEpoch({ id: "a", active_epoch: 2 }, [{ id: "old", account_id: "a", epoch_number: 1, state: "closed" }, { id: "new", account_id: "a", epoch_number: 2, state: "active" }]).id, "new");
});

test("paper order preview derives notional, margin, fee, and total cost", () => {
  assert.deepEqual(paperOrderPreview({
    size: "2", markPrice: 100, limitPrice: "95", orderType: "limit", leverage: 5,
    feeRate: 0.0004, availableMargin: 1000, currentPosition: 0,
  }), {
    price: 95,
    orderValue: 190,
    marginRequired: 38,
    estimatedFee: 0.076,
    estimatedCost: 38.076,
    maxSize: 52.63157894736842,
    currentPosition: 0,
    availableMargin: 1000,
  });
  assert.equal(paperOrderPreview({ size: "", markPrice: 100, orderType: "market", leverage: 20 }).orderValue, null);
  assert.equal(paperOrderPreview({ size: 2, markPrice: 100, executionPrice: 101, orderType: "market", leverage: 20 }).orderValue, 202);
  assert.equal(paperOrderPreview({ size: 1, markPrice: 100, orderType: "market", leverage: 20, availableMargin: 500, reduceOnly: true, side: "sell", currentPosition: 3 }).maxSize, 3);
  assert.equal(paperOrderPreview({ size: 1, markPrice: 100, orderType: "market", leverage: 20, availableMargin: 500, reduceOnly: true, side: "buy", currentPosition: 3 }).maxSize, 0);
  assert.ok(Math.abs(paperOrderPreview({
    size: 1, markPrice: 100, orderType: "market", leverage: 20, availableMargin: 1000,
    marginTiers: [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 5000, maxLeverage: 10 }],
  }).maxSize - 100) < 1e-8);
  assert.equal(paperOrderPreview({
    size: 100, markPrice: 100, orderType: "market", leverage: 20, availableMargin: 1000,
    marginTiers: [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 5000, maxLeverage: 10 }],
  }).marginRequired, 1000);
});

test("market fill preview walks visible book depth and reports slippage", () => {
  assert.deepEqual(estimateMarketFill([
    { px: "100", sz: "2" },
    { px: "101", sz: "3" },
  ], 4, 99, "buy"), {
    averagePrice: 100.5,
    filledSize: 4,
    complete: true,
    slippagePercent: 1.5151515151515151,
  });
  assert.equal(estimateMarketFill([], 4, 99, "buy"), null);
});

test("isolated liquidation estimate reflects side and maximum leverage maintenance", () => {
  assert.ok(Math.abs(estimateIsolatedLiquidationPrice(100, "buy", 10, 20) - 92.3076923076923) < 1e-10);
  assert.ok(Math.abs(estimateIsolatedLiquidationPrice(100, "sell", 10, 20) - 107.3170731707317) < 1e-10);
});

test("paper fee preview selects the earned tier and maker discount", () => {
  const schedule = {
    volumeTiers: [
      { minimumVolume: 0, makerRate: 0.00015, takerRate: 0.00045 },
      { minimumVolume: 5_000_000, makerRate: 0.00012, takerRate: 0.0004 },
    ],
    makerFractionTiers: [{ minimumMakerFraction: 0.2, makerRate: -0.00001 }],
  };
  assert.deepEqual(paperFeeRates(schedule, 5_000_000, 500_000), { maker: 0.00012, taker: 0.0004 });
  assert.deepEqual(paperFeeRates(schedule, 5_000_000, 1_000_000), { maker: -0.00001, taker: 0.0004 });
});

test("Hyperliquid fee payload is normalized for paper previews", () => {
  assert.deepEqual(normalizePaperFeeSchedule({ feeSchedule: {
    add: "0.00015", cross: "0.00045",
    tiers: {
      vip: [{ ntlCutoff: "5000000", add: "0.00012", cross: "0.0004" }],
      mm: [{ makerFractionCutoff: "0.005", add: "-0.00001" }],
    },
  } }), {
    volumeTiers: [
      { minimumVolume: 0, makerRate: 0.00015, takerRate: 0.00045 },
      { minimumVolume: 5_000_000, makerRate: 0.00012, takerRate: 0.0004 },
    ],
    makerFractionTiers: [{ minimumMakerFraction: 0.005, makerRate: -0.00001 }],
  });
});
