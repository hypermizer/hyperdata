import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeLevels,
  atr,
  clusterLevelCandidates,
  groupSessionKey,
  sessionVwap,
  validateOhlcv,
} from "../public/lib/level-engine.js";

function fixture(count = 600, start = Date.UTC(2026, 6, 1, 13, 30)) {
  return Array.from({ length: count }, (_, index) => {
    const center = 50 + index * 0.01 + Math.sin(index / 14) * 1.5;
    const open = center - Math.sin(index / 5) * 0.15;
    const close = center + Math.cos(index / 7) * 0.15;
    return {
      time: start + index * 5 * 60_000,
      open,
      high: Math.max(open, close) + 0.22,
      low: Math.min(open, close) - 0.22,
      close,
      volume: 1000 + (index % 23) * 37,
    };
  });
}

test("validates and normalizes OHLCV while rejecting impossible bars", () => {
  const valid = validateOhlcv(fixture(80));
  assert.equal(valid.length, 80);
  assert.throws(() => validateOhlcv([{ ...fixture(1)[0], high: 1 }]), /invalid OHLCV/i);
  assert.throws(() => validateOhlcv(fixture(79)), /at least 80 bars/i);
});

test("computes Wilder ATR and session VWAP without non-finite output", () => {
  const bars = fixture(120);
  const values = atr(bars, 14);
  assert.equal(values.length, bars.length);
  assert.ok(Number.isFinite(values.at(-1)));
  const vwap = sessionVwap(bars, { mode: "utc" });
  assert.ok(vwap >= Math.min(...bars.map(({ low }) => low)));
  assert.ok(vwap <= Math.max(...bars.map(({ high }) => high)));
  assert.equal(sessionVwap(bars.map((bar) => ({ ...bar, volume: 0 })), { mode: "utc" }), bars.at(-1).close);
});

test("New York session keys honor daylight-saving offsets", () => {
  assert.equal(groupSessionKey(Date.UTC(2026, 2, 9, 13, 30), "new_york_rth"), "2026-03-09");
  assert.equal(groupSessionKey(Date.UTC(2026, 0, 9, 14, 30), "new_york_rth"), "2026-01-09");
});

test("New York VWAP uses the latest completed trading session outside market hours", () => {
  const friday = Date.UTC(2026, 6, 31, 15, 0);
  const saturday = Date.UTC(2026, 7, 1, 15, 0);
  const bars = [
    { time: friday, open: 99, high: 101, low: 99, close: 100, volume: 10 },
    { time: saturday, open: 199, high: 201, low: 199, close: 200, volume: 10 },
  ];
  assert.equal(sessionVwap(bars, { mode: "new_york_rth" }), 100);
  assert.equal(sessionVwap([{ ...bars[0], volume: 0 }, bars[1]], { mode: "new_york_rth" }), 100);
});

test("clusters nearby candidates and exposes score components", () => {
  const levels = clusterLevelCandidates([
    { price: 100, source: "prior_day_low", weight: 3.2 },
    { price: 100.05, source: "60m_swing_low", weight: 2.15 },
    { price: 100.08, source: "prior_day_low", weight: 2.8 },
  ], fixture(200), 102, 0.1, 3);
  assert.equal(levels.length, 1);
  assert.deepEqual(levels[0].sources, ["60m_swing_low", "prior_day_low"]);
  assert.ok(levels[0].scoreComponents.source > 5);
  assert.ok(Number.isFinite(levels[0].score));
});

test("builds ranked levels and risk-sized conditional setups", () => {
  const result = analyzeLevels(fixture(), { ticker: "TEST", riskDollars: 500, sessionMode: "utc" });
  assert.equal(result.summary.ticker, "TEST");
  assert.ok(result.levels.length > 0);
  assert.ok(result.setups.length > 0);
  assert.ok(result.setups.every((setup) => setup.sharesAtRiskBudget === Math.floor(500 / setup.riskPerShare)));
  assert.ok(["strong_uptrend", "uptrend", "range_or_transition", "downtrend", "strong_downtrend"].includes(result.summary.regime));
});
