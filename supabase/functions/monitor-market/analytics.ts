import type { SupabaseClient } from "@supabase/supabase-js";
import { infoRequest, normalizeDexAnalyticsSamples } from "../_shared/hyperliquid.ts";

export async function recordAssetAnalyticsSnapshot(
  client: SupabaseClient,
  bucket: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const results = await Promise.allSettled(["", "xyz"].map(async (dex) => {
    const payload = await infoRequest({ type: "metaAndAssetCtxs", dex }, fetchImpl);
    return normalizeDexAnalyticsSamples(payload);
  }));
  const samples = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`${index === 0 ? "native" : "xyz"}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : []);
  if (!samples.length) throw new Error("Hyperliquid returned no mark prices for asset analytics");
  if (failures.length) console.warn(`Partial asset analytics snapshot: ${failures.join("; ")}`);
  const { data, error } = await client.rpc("record_asset_price_samples", {
    p_bucket: bucket.toISOString(),
    p_samples: samples,
  });
  if (error) throw new Error(error.message);
  return Number(data) || 0;
}
