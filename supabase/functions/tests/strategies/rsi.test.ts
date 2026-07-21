import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { computeWilderRsi, validateCompletedCandles } from "../../_shared/strategies/rsi.ts";
import type { StrategyCandle } from "../../_shared/strategies/types.ts";

function candles(closes: number[], intervalMs = 300_000): StrategyCandle[] {
  return closes.map((close, index) => ({
    asset: "BTC",
    interval: intervalMs === 300_000 ? "5m" : "1h",
    openTime: index * intervalMs,
    closeTime: (index + 1) * intervalMs,
    open: String(close),
    high: String(close),
    low: String(close),
    close: String(close),
    volume: "1",
    completed: true,
  }));
}

Deno.test("Wilder RSI matches a published reference sequence", () => {
  const closes = [54.8, 56.8, 57.85, 59.85, 60.57, 61.1, 62.17, 60.6, 62.35, 62.15, 62.35, 61.45, 62.8, 61.37, 62.5, 62.57, 60.8, 59.37, 60.35, 62.35, 62.17, 62.55, 64.55, 64.37, 65.3, 64.42, 62.9, 61.6, 62.05, 60.05, 59.7, 60.9, 60.25, 58.27, 58.7, 57.72, 58.1, 58.2];
  const values = computeWilderRsi(candles(closes), 14);
  assertAlmostEquals(Number(values[14]), 74.21383647798743, 10e-10);
  assertAlmostEquals(Number(values.at(-1)), 44.524720536432, 10e-10);
});

Deno.test("Wilder RSI handles all-gain, all-loss, and flat series", () => {
  assertEquals(computeWilderRsi(candles(Array.from({ length: 20 }, (_, i) => i + 1)), 14).at(-1), "100");
  assertEquals(computeWilderRsi(candles(Array.from({ length: 20 }, (_, i) => 20 - i)), 14).at(-1), "0");
  assertEquals(computeWilderRsi(candles(Array(20).fill(10)), 14).at(-1), "50");
});

Deno.test("RSI warm-up emits null through the first fourteen candles", () => {
  const values = computeWilderRsi(candles(Array.from({ length: 15 }, (_, i) => i + 1)), 14);
  assertEquals(values.slice(0, 14), Array(14).fill(null));
  assertEquals(values[14], "100");
});

Deno.test("completed candle validation rejects gaps, duplicates, ordering, and incomplete input", () => {
  const valid = candles([1, 2, 3]);
  assertEquals(validateCompletedCandles(valid, "5m"), valid);
  assertThrows(() => validateCompletedCandles([valid[0], { ...valid[1], openTime: 600_000, closeTime: 900_000 }], "5m"), Error, "gap");
  assertThrows(() => validateCompletedCandles([valid[0], valid[0]], "5m"), Error, "strictly ordered");
  assertThrows(() => validateCompletedCandles([{ ...valid[0], completed: false }], "5m"), Error, "incomplete");
});
