import test from "node:test";
import assert from "node:assert/strict";
import {
  activePaperEpoch,
  estimateIsolatedLiquidationPrice,
  estimateMarketFill,
  formatPaperPrice,
  formatPaperNumber,
  normalizeLegacyPaperHistory,
  normalizeAccountName,
  normalizePaperFeeSchedule,
  normalizePaperOrder,
  normalizeStartingCapital,
  paperFeeRates,
  paperInitialMargin,
  paperOrderReceipt,
  paperOrderSize, paperPriceValid,
  paperOrderPreview,
  paperSignClass,
  paperHistoryViewUnavailable,
  resolvePaperCommand,
  scalePerpFeeRate,
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

test("paper order amounts convert from USDC to exchange-valid share precision", () => {
  assert.equal(paperOrderSize("100", "usdc", "53.32", 1), "1.8");
  assert.equal(paperOrderSize("100", "usdc", "25", 3), "4");
  assert.equal(paperOrderSize("0.3", "usdc", "0.1", 1), "3");
  assert.equal(paperOrderSize("0.29", "usdc", "0.1", 1), "2.9");
  assert.equal(paperOrderSize("1.234", "shares", "100", 3), "1.234");
  assert.equal(paperOrderSize("", "usdc", "53.32", 1), null);
  assert.equal(paperOrderSize("100", "usdc", "0", 1), null);
});

test("paper order receipts make successful fills unmistakable", () => {
  assert.deepEqual(paperOrderReceipt({
    fills: [
      { size: "34.6", price: "54.64", fee: "0.17014896" },
      { size: "1.8", price: "54.639", fee: "0.008851518" },
      { size: "8.8", price: "54.638", fee: "0.043273296" },
      { size: "5.3", price: "54.633", fee: "0.026059941" },
      { size: "132.4", price: "54.631", fee: "0.650982996" },
    ],
    order: { asset: "xyz:DRAM", side: "sell", requestedSize: "182.9" },
    response: { status: "filled" },
  }), {
    tone: "success",
    text: "ORDER FILLED — SHORT 182.9 DRAM @ $54.633176 · FEE $0.899317",
  });
  assert.deepEqual(paperOrderReceipt({
    fills: [],
    order: { asset: "xyz:ORCL", side: "buy", requestedSize: "2" },
    response: { status: "resting" },
  }), { tone: "success", text: "ORDER RESTING — LONG 2 ORCL" });
  assert.deepEqual(paperOrderReceipt({
    fills: [{ size: "4", price: "50", fee: "0.09" }],
    order: { asset: "xyz:DRAM", side: "sell", requestedSize: "10" },
    response: { status: "canceled", reason: "visible_depth_exhausted" },
  }), {
    tone: "warning",
    text: "ORDER PARTIALLY FILLED — SHORT 4 DRAM @ $50 · FEE $0.09 · VISIBLE_DEPTH_EXHAUSTED",
  });
});

test("paper history prices retain useful precision without fixed-width noise", () => {
  assert.equal(formatPaperPrice("95000.000000000000"), "$95,000.00");
  assert.equal(formatPaperPrice("54.633176052488"), "$54.63317605");
  assert.equal(formatPaperPrice("0.00001234"), "$0.00001234");
  assert.equal(formatPaperPrice(null), "—");
  assert.equal(paperHistoryViewUnavailable({ code: "PGRST205" }), true);
  assert.equal(paperHistoryViewUnavailable({ code: "42P01" }), true);
  assert.equal(paperHistoryViewUnavailable({ code: "42501" }), false);
  assert.deepEqual(normalizeLegacyPaperHistory([{ id: "1", created_at: "2026-07-21T10:00:00Z" }]), [{
    id: "1", created_at: "2026-07-21T10:00:00Z", event_at: "2026-07-21T10:00:00Z", asset_price: null,
  }]);
});

test("ambiguous paper command responses reconcile against the idempotent result", async () => {
  const stored = { response: { status: "filled" } };
  let lookups = 0;
  assert.deepEqual(await resolvePaperCommand(
    async () => ({ data: null, error: new Error("network response lost") }),
    async () => { lookups += 1; return lookups === 2 ? stored : null; },
    { attempts: 3, wait: async () => {} },
  ), { data: stored, reconciled: true });
  assert.equal(lookups, 2);

  let successLookups = 0;
  assert.deepEqual(await resolvePaperCommand(
    async () => ({ data: stored, error: null }),
    async () => { successLookups += 1; return null; },
  ), { data: stored, reconciled: false });
  assert.equal(successLookups, 0);
});

test("unresolved ambiguous paper command responses remain explicitly unknown", async () => {
  const failure = new Error("request rejected");
  await assert.rejects(resolvePaperCommand(
    async () => ({ data: null, error: failure }),
    async () => null,
    { attempts: 2, wait: async () => {} },
  ), (error) => error.name === "PaperCommandOutcomeUnknownError" && error.outcomeUnknown === true && error.cause === failure);
});

test("thrown transport failures also reconcile against the idempotent result", async () => {
  const stored = { response: { status: "filled" } };
  assert.deepEqual(await resolvePaperCommand(
    async () => { throw new Error("connection reset"); },
    async () => stored,
    { wait: async () => {} },
  ), { data: stored, reconciled: true });
});

test("definitive paper command rejections do not poll for a committed result", async () => {
  const failure = Object.assign(new Error("invalid order"), { context: { status: 422 } });
  let lookups = 0;
  await assert.rejects(resolvePaperCommand(
    async () => ({ data: null, error: failure }),
    async () => { lookups += 1; return null; },
  ), failure);
  assert.equal(lookups, 0);
});

test("paper limit prices follow Hyperliquid tick precision", () => {
  assert.equal(paperPriceValid("53.32", 1), true);
  assert.equal(paperPriceValid("53.3219", 1), false);
  assert.equal(paperPriceValid("0.012345", 2), false);
  assert.equal(paperPriceValid("12345", 3), true);
  assert.equal(paperPriceValid("12346.7", 3), false);
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
    maxSize: 52.52652589557726,
    currentPosition: 0,
    availableMargin: 1000,
  });
  assert.equal(paperOrderPreview({ size: "", markPrice: 100, orderType: "market", leverage: 20 }).orderValue, null);
  assert.equal(paperOrderPreview({ size: 2, markPrice: 100, executionPrice: 101, orderType: "market", leverage: 20 }).orderValue, 202);
  assert.equal(paperOrderPreview({ size: 1, markPrice: 100, orderType: "market", leverage: 20, availableMargin: 500, reduceOnly: true, side: "sell", currentPosition: 3 }).maxSize, 3);
  assert.equal(paperOrderPreview({ size: 1, markPrice: 100, orderType: "market", leverage: 20, availableMargin: 500, reduceOnly: true, side: "buy", currentPosition: 3 }).maxSize, 0);
  assert.ok(Math.abs(paperOrderPreview({
    size: 1, markPrice: 100, orderType: "market", leverage: 2, availableMargin: 0,
    currentMargin: 500, currentPosition: 10, side: "sell",
  }).maxSize - 20) < 1e-8);
  assert.ok(Math.abs(paperOrderPreview({
    size: 1, markPrice: 100, orderType: "market", leverage: 20, availableMargin: 1000,
    marginTiers: [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 5000, maxLeverage: 10 }],
  }).maxSize - 100) < 1e-8);
  assert.equal(paperOrderPreview({
    size: 100, markPrice: 100, orderType: "market", leverage: 20, availableMargin: 1000,
    marginTiers: [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 5000, maxLeverage: 10 }],
  }).marginRequired, 1000);
});

test("paper initial margin respects the active notional tier", () => {
  assert.equal(paperInitialMargin(4_000, 20, [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 5_000, maxLeverage: 10 }]), 200);
  assert.equal(paperInitialMargin(5_000, 20, [{ lowerBound: 0, maxLeverage: 20 }, { lowerBound: 5_000, maxLeverage: 10 }]), 500);
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

test("HIP-3 fee scaling follows deployer and growth-mode mechanics", () => {
  const growthMarket = { dexId: "xyz", deployerFeeScale: 1, growthMode: "enabled" };
  assert.ok(Math.abs(scalePerpFeeRate(0.00045, growthMarket, "taker") - 0.00009) < 1e-15);
  assert.ok(Math.abs(scalePerpFeeRate(0.00015, growthMarket, "maker") - 0.00003) < 1e-15);
  assert.ok(Math.abs(scalePerpFeeRate(-0.00001, growthMarket, "maker") + 0.000001) < 1e-15);
  assert.equal(scalePerpFeeRate(0.00045, { dexId: "", deployerFeeScale: null }, "taker"), 0.00045);
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
