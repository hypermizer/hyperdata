import type { StrategyCandle, StrategyInterval } from "./types.ts";
import { validateCompletedCandles } from "./rsi.ts";

export function mergeStrategyCandles(
  persisted: readonly StrategyCandle[],
  fetched: readonly StrategyCandle[],
  interval: StrategyInterval,
  completedBeforeMs = Date.now(),
): StrategyCandle[] {
  const merged = new Map<number, StrategyCandle>();
  for (const candle of [...persisted, ...fetched]) {
    if (candle.interval === interval && candle.completed && candle.closeTime <= completedBeforeMs) {
      merged.set(candle.openTime, candle);
    }
  }
  return validateCompletedCandles([...merged.values()].sort((a, b) => a.openTime - b.openTime), interval);
}

export function actualCoverage(candles: readonly StrategyCandle[]) {
  if (candles.length === 0) return { start: null, end: null, candleCount: 0 };
  return { start: candles[0].openTime, end: candles.at(-1)!.closeTime, candleCount: candles.length };
}
