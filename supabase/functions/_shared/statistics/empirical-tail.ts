export function empiricalPercentile(value: number, history: number[]): number | null {
  if (!Number.isFinite(value)) return null;
  let count = 0; let sampleCount = 0;
  for (const item of history) {
    if (!Number.isFinite(item)) continue;
    sampleCount += 1; if (item <= value) count += 1;
  }
  return sampleCount ? count / sampleCount : null;
}
