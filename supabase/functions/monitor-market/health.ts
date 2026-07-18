export function utcMinute(date = new Date()): Date {
  const bucket = new Date(date); bucket.setUTCSeconds(0, 0); return bucket;
}
export function classifyRun(observationCount: number, requestedCount: number, failureCount: number): "succeeded" | "partial" | "failed" {
  if (observationCount === 0 && requestedCount > 0) return "failed";
  return failureCount > 0 || observationCount < requestedCount ? "partial" : "succeeded";
}
export function storageProjectionBytes(assetCount: number, retentionDays = 30): number { return assetCount * retentionDays * 1440 * 180; }
