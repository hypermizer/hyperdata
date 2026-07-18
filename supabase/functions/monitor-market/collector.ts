import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchMarketBatches, type AssetRequest } from "../_shared/hyperliquid.ts";
import type { MarketObservation } from "../_shared/types.ts";

export async function collectMarketObservations(client: SupabaseClient, assets: AssetRequest[], bucket: Date, fetchImpl: typeof fetch = fetch) {
  const batches = await fetchMarketBatches(assets, bucket, fetchImpl);
  const observations: MarketObservation[] = []; const failures: Record<string, string> = {};
  batches.forEach((result, dex) => {
    if (!result.ok) { failures[dex || "main"] = result.error; return; }
    observations.push(...result.observations);
    const expected = assets.filter((item) => item.dex === dex).map((item) => item.asset);
    const received = new Set(result.observations.map((item) => item.asset));
    const missing = expected.filter((asset) => !received.has(asset));
    if (missing.length) failures[dex || "main"] = `Invalid or missing context: ${missing.join(", ")}`;
  });
  if (observations.length) {
    const { error } = await client.from("market_observations").upsert(observations, { onConflict: "asset,bucket", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  return { observations, failures };
}
