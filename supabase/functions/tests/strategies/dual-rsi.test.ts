import { assertEquals } from "@std/assert";
import { evaluateDualRsi, transitionRearm } from "../../_shared/strategies/dual-rsi.ts";
import type { RelativeRsiPoint, StrategyCandle } from "../../_shared/strategies/types.ts";

function candles(count: number, interval: "5m" | "1h", close = "100"): StrategyCandle[] {
  const width = interval === "5m" ? 300_000 : 3_600_000;
  return Array.from({ length: count }, (_, index) => ({
    asset: "BTC", interval, openTime: index * width, closeTime: (index + 1) * width,
    open: close, high: close, low: close, close, volume: "1", completed: true,
  }));
}

const shortPoint: RelativeRsiPoint = { rsi: "95", baseline: "50", ratio: "1.9", candleCloseTime: 1 };
const longPoint: RelativeRsiPoint = { rsi: "5", baseline: "50", ratio: "0.1", candleCloseTime: 1 };
const neutralPoint: RelativeRsiPoint = { rsi: "50", baseline: "50", ratio: "1", candleCloseTime: 1 };

Deno.test("literal inclusive boundaries require both timeframes", () => {
  assertEquals(evaluateDualRsi(shortPoint, shortPoint, true).decision, "enter_short");
  assertEquals(evaluateDualRsi(longPoint, longPoint, true).decision, "enter_long");
  assertEquals(evaluateDualRsi(shortPoint, neutralPoint, true).decision, "hold");
  assertEquals(evaluateDualRsi(longPoint, neutralPoint, true).decision, "hold");
});

Deno.test("persistent extremes do not re-enter until neutral input rearms", () => {
  assertEquals(evaluateDualRsi(shortPoint, shortPoint, false).decision, "hold");
  assertEquals(transitionRearm(false, shortPoint, shortPoint), false);
  assertEquals(transitionRearm(false, neutralPoint, neutralPoint), true);
});

Deno.test("baseline uses exactly 100 prior RSI readings and excludes current", () => {
  const risingFiveMinute = candles(115, "5m").map((candle, i) => ({ ...candle, close: String(100 + i), open: String(100 + i), high: String(100 + i), low: String(100 + i) }));
  const risingHourly = candles(115, "1h").map((candle, i) => ({ ...candle, close: String(100 + i), open: String(100 + i), high: String(100 + i), low: String(100 + i) }));
  const result = evaluateDualRsi(risingFiveMinute, risingHourly, true);
  assertEquals(result.status, "armed");
  assertEquals(result.fiveMinute?.baseline, "100");
  assertEquals(result.fiveMinute?.rsi, "100");
  assertEquals(result.fiveMinute?.ratio, "1");
});

Deno.test("one candle short of the baseline boundary remains warming", () => {
  assertEquals(evaluateDualRsi(candles(114, "5m"), candles(115, "1h"), true).status, "warming");
});

Deno.test("identical completed input produces an identical audit payload", () => {
  const fiveMinute = candles(115, "5m");
  const hourly = candles(115, "1h");
  assertEquals(evaluateDualRsi(fiveMinute, hourly, true), evaluateDualRsi(fiveMinute, hourly, true));
});
