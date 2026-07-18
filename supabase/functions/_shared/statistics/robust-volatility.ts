export const MODEL_VERSION = "robust-ewma-v1";
export function ewmaAlpha(halfLife: number): number { return 1 - Math.exp(Math.log(0.5) / halfLife); }
export function clippedResidual(value: number, variance: number, sigmaLimit = 6): number {
  const limit = sigmaLimit * Math.sqrt(Math.max(variance, Number.EPSILON)); return Math.max(-limit, Math.min(limit, value));
}
export function updateVariance(previous: number, residual: number, halfLife: number): number {
  const clipped = clippedResidual(residual, previous); const alpha = ewmaAlpha(halfLife); return (1 - alpha) * previous + alpha * clipped ** 2;
}
export function forecastHorizonVariance(fastVariance: number, slowVariance: number, horizonMinutes: number, sessionFactor = 1): number {
  if (fastVariance <= 0 || slowVariance <= 0 || horizonMinutes < 1) throw new Error("Invalid variance forecast input");
  return (0.65 * fastVariance + 0.35 * slowVariance) * sessionFactor * horizonMinutes;
}
export function shrunkSessionFactor(sessionVariance: number, globalVariance: number, samples: number, priorStrength = 100): number {
  if (globalVariance <= 0 || samples < 0) return 1; const raw = sessionVariance > 0 ? sessionVariance / globalVariance : 1;
  return (samples * raw + priorStrength) / (samples + priorStrength);
}
