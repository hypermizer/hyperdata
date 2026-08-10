import type { SupabaseClient } from "@supabase/supabase-js";
import { infoRequest, normalizeDexAnalyticsSamples } from "../_shared/hyperliquid.ts";

export async function recordAssetAnalyticsSnapshot(
  client: SupabaseClient,
  bucket: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const samples = normalizeDexAnalyticsSamples(await infoRequest(
    { type: "metaAndAssetCtxs", dex: "xyz" },
    fetchImpl,
  ));
  if (!samples.length) throw new Error("Hyperliquid returned no XYZ mark prices for asset analytics");
  const { data, error } = await client.rpc("record_asset_price_samples", {
    p_bucket: bucket.toISOString(),
    p_samples: samples,
  });
  if (error) throw new Error(error.message);
  return Number(data) || 0;
}
