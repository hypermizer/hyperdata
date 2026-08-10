import type { AlertRule } from "../_shared/types.ts";

export const MONITOR_INTERVAL_SECONDS = 15;

export function monitorBucket(date = new Date()): Date {
  const intervalMs = MONITOR_INTERVAL_SECONDS * 1000;
  return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs);
}

export function isMinuteBucket(bucket: Date): boolean {
  return bucket.getUTCSeconds() === 0;
}

export function isAnalyticsBucket(bucket: Date): boolean {
  return isMinuteBucket(bucket);
}

export function rulesForBucket(rules: AlertRule[], bucket: Date): AlertRule[] {
  if (isMinuteBucket(bucket)) return rules;
  return rules.filter((rule) => rule.detector === "fixed_price");
}

export function assetIdsForBucket(rules: AlertRule[], watchlist: Array<{ asset: string }>, bucket: Date): string[] {
  const assets = rulesForBucket(rules, bucket).map((rule) => rule.asset);
  if (isMinuteBucket(bucket)) assets.push(...watchlist.map(({ asset }) => asset));
  return [...new Set(assets)];
}
