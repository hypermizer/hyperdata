import { decimal, decimalString } from "../paper/decimal.ts";
import { computeWilderRsi } from "./rsi.ts";
import {
  DEFAULT_DUAL_RSI_PARAMETERS,
  type DualRsiEvaluation,
  type DualRsiParameters,
  type RelativeRsiPoint,
  type StrategyCandle,
} from "./types.ts";

export function relativeRsiPoint(
  candles: readonly StrategyCandle[],
  period: number,
  baselineLength: number,
): RelativeRsiPoint | null {
  const readings = computeWilderRsi(candles, period);
  const current = readings.at(-1);
  if (current == null) return null;
  const prior = readings.slice(0, -1).filter((value): value is string => value != null);
  if (prior.length < baselineLength) return null;
  const baselineValues = prior.slice(-baselineLength);
  const baseline = baselineValues.reduce((sum, value) => sum.plus(value), decimal(0)).div(baselineLength);
  if (baseline.isZero() && !decimal(current).isZero()) {
    throw new Error("RSI baseline is zero while current RSI is nonzero");
  }
  const ratio = baseline.isZero() ? decimal(1) : decimal(current).div(baseline);
  return {
    rsi: decimalString(current),
    baseline: decimalString(baseline),
    ratio: decimalString(ratio),
    candleCloseTime: candles.at(-1)!.closeTime,
    sourceVersion: candles.at(-1)!.sourceVersion,
  };
}

export function relativeRsiSeries(
  candles: readonly StrategyCandle[],
  period: number,
  baselineLength: number,
): Array<RelativeRsiPoint | null> {
  const readings = computeWilderRsi(candles, period);
  const output: Array<RelativeRsiPoint | null> = [];
  const prior: string[] = [];
  let rollingSum = decimal(0);
  readings.forEach((current, index) => {
    if (current == null || prior.length < baselineLength) output.push(null);
    else {
      const baseline = rollingSum.div(baselineLength);
      if (baseline.isZero() && !decimal(current).isZero()) throw new Error("RSI baseline is zero while current RSI is nonzero");
      output.push({ rsi: decimalString(current), baseline: decimalString(baseline),
        ratio: decimalString(baseline.isZero() ? decimal(1) : decimal(current).div(baseline)),
        candleCloseTime: candles[index].closeTime, sourceVersion: candles[index].sourceVersion });
    }
    if (current != null) {
      prior.push(current);
      rollingSum = rollingSum.plus(current);
      if (prior.length > baselineLength) rollingSum = rollingSum.minus(prior.shift()!);
    }
  });
  return output;
}

function evaluatePoints(
  fiveMinute: RelativeRsiPoint | null,
  oneHour: RelativeRsiPoint | null,
  rearmReady: boolean,
  parameters: Readonly<DualRsiParameters>,
): DualRsiEvaluation {
  if (!fiveMinute || !oneHour) {
    return { status: "warming", decision: "warming", fiveMinute, oneHour, rearmReady };
  }
  const shortExtreme = decimal(fiveMinute.ratio).gte(parameters.shortRatio) && decimal(oneHour.ratio).gte(parameters.shortRatio);
  const longExtreme = decimal(fiveMinute.ratio).lte(parameters.longRatio) && decimal(oneHour.ratio).lte(parameters.longRatio);
  const decision = !rearmReady ? "hold" : shortExtreme ? "enter_short" : longExtreme ? "enter_long" : "hold";
  return { status: "armed", decision, fiveMinute, oneHour, rearmReady };
}

export function transitionRearm(
  rearmReady: boolean,
  fiveMinute: RelativeRsiPoint,
  oneHour: RelativeRsiPoint,
  parameters: Readonly<DualRsiParameters> = DEFAULT_DUAL_RSI_PARAMETERS,
): boolean {
  if (rearmReady) return true;
  const stillShort = decimal(fiveMinute.ratio).gte(parameters.shortRatio) && decimal(oneHour.ratio).gte(parameters.shortRatio);
  const stillLong = decimal(fiveMinute.ratio).lte(parameters.longRatio) && decimal(oneHour.ratio).lte(parameters.longRatio);
  return !stillShort && !stillLong;
}

export function evaluateDualRsi(
  fiveMinute: readonly StrategyCandle[] | RelativeRsiPoint,
  oneHour: readonly StrategyCandle[] | RelativeRsiPoint,
  rearmReady: boolean,
  parameters: Readonly<DualRsiParameters> = DEFAULT_DUAL_RSI_PARAMETERS,
): DualRsiEvaluation {
  if (Array.isArray(fiveMinute) && Array.isArray(oneHour)) {
    return evaluatePoints(
      relativeRsiPoint(fiveMinute, parameters.rsiPeriod, parameters.baselineLength),
      relativeRsiPoint(oneHour, parameters.rsiPeriod, parameters.baselineLength),
      rearmReady,
      parameters,
    );
  }
  return evaluatePoints(
    fiveMinute as RelativeRsiPoint,
    oneHour as RelativeRsiPoint,
    rearmReady,
    parameters,
  );
}
