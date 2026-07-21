import { decimal, decimalString } from "../paper/decimal.ts";
import type { StrategyCandle, StrategyInterval } from "./types.ts";

const INTERVAL_MS: Record<StrategyInterval, number> = { "5m": 300_000, "1h": 3_600_000 };

export function validateCompletedCandles(
  candles: readonly StrategyCandle[],
  interval: StrategyInterval,
): StrategyCandle[] {
  const width = INTERVAL_MS[interval];
  const validated = [...candles];
  for (let index = 0; index < validated.length; index += 1) {
    const candle = validated[index];
    if (!candle.completed) throw new Error("incomplete candle");
    if (candle.interval !== interval || candle.closeTime - candle.openTime !== width) {
      throw new Error(`invalid ${interval} candle width`);
    }
    decimal(candle.open);
    decimal(candle.high);
    decimal(candle.low);
    decimal(candle.close);
    decimal(candle.volume);
    if (index > 0) {
      const previous = validated[index - 1];
      if (candle.openTime <= previous.openTime) throw new Error("candles must be strictly ordered");
      if (candle.openTime !== previous.closeTime) throw new Error("candle gap");
      if (candle.asset !== previous.asset) throw new Error("mixed candle assets");
    }
  }
  return validated;
}

export function computeWilderRsi(candles: readonly StrategyCandle[], period = 14): Array<string | null> {
  if (!Number.isInteger(period) || period < 1) throw new Error("RSI period must be a positive integer");
  if (candles.length === 0) return [];
  validateCompletedCandles(candles, candles[0].interval);

  const output: Array<string | null> = Array(candles.length).fill(null);
  if (candles.length <= period) return output;

  let averageGain = decimal(0);
  let averageLoss = decimal(0);
  for (let index = 1; index <= period; index += 1) {
    const change = decimal(candles[index].close).minus(candles[index - 1].close);
    if (change.isPositive()) averageGain = averageGain.plus(change);
    else averageLoss = averageLoss.plus(change.abs());
  }
  averageGain = averageGain.div(period);
  averageLoss = averageLoss.div(period);

  const toRsi = (): string => {
    if (averageGain.isZero() && averageLoss.isZero()) return "50";
    if (averageLoss.isZero()) return "100";
    if (averageGain.isZero()) return "0";
    return decimalString(decimal(100).minus(decimal(100).div(decimal(1).plus(averageGain.div(averageLoss)))));
  };

  output[period] = toRsi();
  for (let index = period + 1; index < candles.length; index += 1) {
    const change = decimal(candles[index].close).minus(candles[index - 1].close);
    const gain = change.isPositive() ? change : decimal(0);
    const loss = change.isNegative() ? change.abs() : decimal(0);
    averageGain = averageGain.mul(period - 1).plus(gain).div(period);
    averageLoss = averageLoss.mul(period - 1).plus(loss).div(period);
    output[index] = toRsi();
  }
  return output;
}
