import { logReturn } from "../_shared/statistics/returns.ts";
import { MODEL_VERSION, shrunkSessionFactor, updateVariance } from "../_shared/statistics/robust-volatility.ts";

export interface Candle { t?: number | string; T?: number | string; c?: number | string }
export interface CalibrationParameters { fastVariance: number; slowVariance: number; sessionFactor: number; absoluteScores: number[] }

export function buildBootstrapModel(candles: Candle[], horizonMinutes: number, intervalMinutes = 1, source = "bootstrap") {
  const points = candles.map((c) => ({ time: Number(c.T ?? c.t), price: Number(c.c) }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.time - b.time);
  const horizonSteps = Math.max(1, Math.round(horizonMinutes / intervalMinutes));
  if (points.length < 101 + horizonSteps) throw new Error("Insufficient candle history");
  const expectedPoints = Math.floor((points.at(-1)!.time - points[0].time) / (intervalMinutes * 60_000)) + 1;
  if (points.length / expectedPoints < 0.95) throw new Error("Insufficient history coverage");
  const oneMinuteReturns: number[] = [];
  for (let i = 1; i < points.length; i += 1) if (points[i].time - points[i - 1].time <= intervalMinutes * 120_000) oneMinuteReturns.push(logReturn(points[i].price, points[i - 1].price) / Math.sqrt(intervalMinutes));
  if (oneMinuteReturns.length < 100) throw new Error("Insufficient contiguous candle history");
  const initialWindow = oneMinuteReturns.slice(0, 30);
  const initial = Math.max(initialWindow.reduce((sum, value) => sum + value ** 2, 0) / initialWindow.length, 1e-12);
  let fastVariance = initial; let slowVariance = initial; const absoluteScores: number[] = [];
  const sessionVarianceSamples = new Map<string, number[]>(); const absoluteScoresBySession: Record<string, number[]> = {};
  const scoreRecords: Array<{ score: number; sessionKey: string; slowVariance: number }> = [];
  for (let i = horizonSteps; i < points.length; i += 1) {
    const candidate = logReturn(points[i].price, points[i - horizonSteps].price);
    const sigma = Math.sqrt((0.65 * fastVariance + 0.35 * slowVariance) * horizonMinutes);
    if (i > 100) {
      const sessionKey = String(new Date(points[i].time).getUTCDay() * 24 + new Date(points[i].time).getUTCHours());
      const absoluteScore = Math.abs(candidate / sigma); absoluteScores.push(absoluteScore);
      (absoluteScoresBySession[sessionKey] ??= []).push(absoluteScore);
      scoreRecords.push({ score: absoluteScore, sessionKey, slowVariance });
    }
    const oneMinute = logReturn(points[i].price, points[i - 1].price) / Math.sqrt(intervalMinutes);
    const minuteSessionKey = String(new Date(points[i].time).getUTCDay() * 24 + new Date(points[i].time).getUTCHours());
    if (!sessionVarianceSamples.has(minuteSessionKey)) sessionVarianceSamples.set(minuteSessionKey, []);
    sessionVarianceSamples.get(minuteSessionKey)!.push(oneMinute ** 2);
    fastVariance = updateVariance(fastVariance, oneMinute, Math.max(1, 30 / intervalMinutes));
    slowVariance = updateVariance(slowVariance, oneMinute, Math.max(1, 360 / intervalMinutes));
  }
  const globalVariance = oneMinuteReturns.reduce((sum, value) => sum + value ** 2, 0) / oneMinuteReturns.length;
  const sessionFactors = Object.fromEntries([...sessionVarianceSamples].map(([key, samples]) => {
    const sessionVariance = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    return [key, shrunkSessionFactor(sessionVariance, globalVariance, samples.length)];
  }));
  const slowVariances = scoreRecords.map((record) => record.slowVariance).sort((left, right) => left - right);
  const regimeThresholds: [number, number] = [slowVariances[Math.floor(slowVariances.length / 3)], slowVariances[Math.floor(2 * slowVariances.length / 3)]];
  const absoluteScoresByRegime: Record<string, number[]> = {}; const absoluteScoresBySessionRegime: Record<string, number[]> = {};
  scoreRecords.forEach((record) => {
    const regime = record.slowVariance <= regimeThresholds[0] ? "low" : record.slowVariance <= regimeThresholds[1] ? "middle" : "high";
    (absoluteScoresByRegime[regime] ??= []).push(record.score);
    (absoluteScoresBySessionRegime[`${record.sessionKey}:${regime}`] ??= []).push(record.score);
  });
  return { modelVersion: `${MODEL_VERSION}-${source}-1-${points.at(-1)!.time}-${horizonMinutes}-${intervalMinutes}`, parameters: { fastVariance, slowVariance, sessionFactor: 1,
    sessionFactors, absoluteScores, absoluteScoresBySession, regimeThresholds, absoluteScoresByRegime, absoluteScoresBySessionRegime },
    sampleCount: absoluteScores.length, coverageStart: new Date(points[0].time).toISOString(), coverageEnd: new Date(points.at(-1)!.time).toISOString() };
}

export async function fetchCalibrationCandles(asset: string, horizonMinutes: number, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ candles: Candle[]; intervalMinutes: number }> {
  const intervalMinutes = horizonMinutes <= 60 ? 1 : horizonMinutes <= 1440 ? 5 : 60;
  const interval = intervalMinutes === 1 ? "1m" : intervalMinutes === 5 ? "5m" : "1h";
  const response = await fetchImpl("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: asset, interval, startTime: now - 5000 * intervalMinutes * 60_000, endTime: now } }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Hyperliquid returned ${response.status}`);
  const payload = await response.json(); if (!Array.isArray(payload)) throw new Error("Malformed candle response"); return { candles: payload, intervalMinutes };
}
