import test from "node:test";
import assert from "node:assert/strict";
import { assessLevelData, defaultLevelSession, mergeLevelCandle, splitLevelCandles } from "../public/lib/level-data.js";

function candle(time, close = 100) {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

test("keeps the open five-minute candle out of completed analysis", () => {
  const now = Date.UTC(2026, 7, 4, 12, 7);
  const { completed, live } = splitLevelCandles([
    candle(Date.UTC(2026, 7, 4, 11, 55) / 1000),
    candle(Date.UTC(2026, 7, 4, 12, 0) / 1000),
    candle(Date.UTC(2026, 7, 4, 12, 5) / 1000),
  ], now);
  assert.equal(completed.length, 2);
  assert.equal(live.time, Date.UTC(2026, 7, 4, 12, 5));
});

test("merges websocket replacements without duplicating candle timestamps", () => {
  const start = Date.UTC(2026, 7, 4, 12);
  const merged = mergeLevelCandle([candle(start, 100)], candle(start / 1000, 102));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].close, 102);
});

test("reports stale or insufficient history and applies session defaults", () => {
  const now = Date.UTC(2026, 7, 4, 12);
  const bars = Array.from({ length: 80 }, (_, index) => candle(now - (80 - index) * 300_000));
  assert.equal(assessLevelData(bars, now).usable, true);
  assert.equal(assessLevelData(bars.slice(0, 20), now).usable, false);
  assert.equal(defaultLevelSession({ category: "equities" }), "new_york_rth");
  assert.equal(defaultLevelSession({ category: "stocks" }), "new_york_rth");
  assert.equal(defaultLevelSession({ category: "commodities" }), "utc");
});
