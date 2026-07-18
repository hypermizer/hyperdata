import { empiricalPercentile } from "../statistics/empirical-tail.ts";
import { logReturn, simplePercent } from "../statistics/returns.ts";
import { forecastHorizonVariance } from "../statistics/robust-volatility.ts";
import type { AlertRule, DetectorContext, DetectorResult } from "./types.ts";

function nonTrigger(status: DetectorResult["status"], evidence: Record<string, unknown>): DetectorResult {
  return { status, qualifies: false, score: null, tailPercentile: null, classification: "uncertain", evidence, modelVersion: null, referenceAgeSeconds: null };
}

export function evaluateLargeMove(rule: AlertRule, context: DetectorContext): DetectorResult {
  const horizon = Number(rule.configuration.horizon_minutes);
  if (!context.reference) return nonTrigger("data_gap", { reason: "reference unavailable", horizonMinutes: horizon });
  const referenceAgeSeconds = Math.round((Date.parse(context.current.bucket) - Date.parse(context.reference.bucket)) / 1000);
  if (Math.abs(referenceAgeSeconds - horizon * 60) > 75) return { ...nonTrigger("data_gap", { reason: "stale reference", horizonMinutes: horizon }), referenceAgeSeconds };
  const model = context.model;
  if (!model || model.sample_count < 100 || Date.parse(model.expires_at) <= Date.now()) return { ...nonTrigger("warming", { reason: "calibration unavailable", horizonMinutes: horizon }), referenceAgeSeconds };
  const returnValue = logReturn(context.current.mark_price, context.reference.mark_price);
  const movePercent = simplePercent(returnValue);
  const stateIsFresh = context.volatilityState && Date.parse(context.current.bucket) - Date.parse(context.volatilityState.last_bucket) <= 120_000;
  const fastVariance = stateIsFresh ? context.volatilityState!.fast_variance : model.parameters.fastVariance;
  const slowVariance = stateIsFresh ? context.volatilityState!.slow_variance : model.parameters.slowVariance;
  const date = new Date(context.current.bucket); const sessionKey = String(date.getUTCDay() * 24 + date.getUTCHours());
  const sessionFactor = model.parameters.sessionFactors?.[sessionKey] ?? model.parameters.sessionFactor;
  const variance = forecastHorizonVariance(fastVariance, slowVariance, horizon, sessionFactor);
  const score = returnValue / Math.sqrt(variance);
  const thresholds = model.parameters.regimeThresholds;
  const regime = !thresholds ? "unclassified" : slowVariance <= thresholds[0] ? "low" : slowVariance <= thresholds[1] ? "middle" : "high";
  const sessionRegimeScores = model.parameters.absoluteScoresBySessionRegime?.[`${sessionKey}:${regime}`] ?? [];
  const sessionScores = model.parameters.absoluteScoresBySession?.[sessionKey] ?? [];
  const regimeScores = model.parameters.absoluteScoresByRegime?.[regime] ?? [];
  const calibrationScores = sessionRegimeScores.length >= 100 ? sessionRegimeScores : sessionScores.length >= 100 ? sessionScores : regimeScores.length >= 100 ? regimeScores : model.parameters.absoluteScores;
  const percentile = empiricalPercentile(Math.abs(score), calibrationScores);
  if (percentile === null) return { ...nonTrigger("warming", { reason: "empty empirical distribution" }), referenceAgeSeconds };
  const requestedDirection = String(rule.configuration.direction);
  const directionMatches = requestedDirection === "either" || (requestedDirection === "up" && score > 0) || (requestedDirection === "down" && score < 0);
  const qualifies = directionMatches && percentile >= Number(rule.configuration.tail_percentile) && Math.abs(movePercent) >= Number(rule.configuration.minimum_move_percent);
  const oracleReturn = context.current.oracle_price && context.reference.oracle_price ? logReturn(context.current.oracle_price, context.reference.oracle_price) : null;
  const classification = oracleReturn === null ? "uncertain" : Math.abs(returnValue - oracleReturn) > Math.max(Math.sqrt(variance), 0.001) ? "venue_dislocation" : "underlying_move";
  return { status: qualifies ? "triggered" : "not_triggered", qualifies, score, tailPercentile: percentile, classification,
    modelVersion: model.model_version, referenceAgeSeconds,
    evidence: { horizonMinutes: horizon, logReturn: returnValue, movePercent, forecastSigma: Math.sqrt(variance), score, empiricalPercentile: percentile,
      modelSource: model.source, sampleCount: model.sample_count, sessionKey, volatilityRegime: regime, calibrationSampleCount: calibrationScores.length, oracleLogReturn: oracleReturn,
      markPrice: context.current.mark_price, oraclePrice: context.current.oracle_price, midPrice: context.current.mid_price,
      openInterest: context.current.open_interest, dayVolume: context.current.day_volume } };
}
