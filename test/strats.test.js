import assert from "node:assert/strict";
import test from "node:test";
import { displayStrategyAsset, strategyRuleSummary, strategyStateLabel, summarizeBacktest } from "../public/lib/strats.js";

test("strategy rule summary states the literal formulas", () => {
  const summary = strategyRuleSummary({ rsiPeriod: 14, baselineLength: 100, shortRatio: "1.9", longRatio: "0.1", stopReturn: "-0.1", takeReturn: "0.2" });
  assert.match(summary, /WILDER RSI\(14\)/);
  assert.match(summary, /CURRENT ÷ PRIOR-100 AVERAGE/);
  assert.match(summary, /≥ 1\.90/);
  assert.match(summary, /NET RETURN ON INITIAL MARGIN/);
});

test("strategy asset names hide the xyz provider", () => {
  assert.equal(displayStrategyAsset("xyz:DRAM"), "DRAM");
  assert.equal(displayStrategyAsset("BTC"), "BTC");
});

test("states and zero-trade backtests remain explicit", () => {
  assert.equal(strategyStateLabel({ state: "degraded", degraded_reason: "candle_gap" }), "DEGRADED · CANDLE GAP");
  assert.equal(summarizeBacktest({ status: "completed", progress: 100, metrics: { portfolio: { tradeCount: 0, netPnl: "0" } } }), "COMPLETED · 0 TRADES · $0.00");
});
