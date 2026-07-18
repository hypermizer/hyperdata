import type { MarketObservation } from "./types.ts";
export const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";
export interface AssetRequest { asset: string; dex: string }
export type DexResult = { ok: true; observations: MarketObservation[] } | { ok: false; error: string };
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null;
};
function positive(value: unknown, label: string, required = false): number | null {
  const parsed = numberOrNull(value);
  if (parsed === null) { if (required) throw new Error(`Missing ${label}`); return null; }
  if (parsed <= 0) throw new Error(`Invalid ${label}`); return parsed;
}
function nonNegative(value: unknown, label: string): number | null {
  const parsed = numberOrNull(value); if (parsed !== null && parsed < 0) throw new Error(`Invalid ${label}`); return parsed;
}
export function normalizeDexContext(dex: string, payload: unknown, requested: Set<string>, bucket: Date, observedAt = new Date()): MarketObservation[] {
  if (!Array.isArray(payload) || payload.length !== 2) throw new Error("Malformed market response");
  const [meta, contexts] = payload as [{ universe?: Array<{ name?: string }> }, Array<Record<string, unknown>>];
  if (!Array.isArray(meta?.universe) || !Array.isArray(contexts) || meta.universe.length !== contexts.length) throw new Error("Mismatched market contexts");
  const rows: MarketObservation[] = [];
  meta.universe.forEach((entry, index) => {
    const asset = entry.name; if (!asset || !requested.has(asset)) return;
    const context = contexts[index] ?? {};
    try {
      rows.push({ asset, dex, bucket: bucket.toISOString(), observed_at: observedAt.toISOString(),
        mark_price: positive(context.markPx, "mark price", true)!, oracle_price: positive(context.oraclePx, "oracle price"),
        mid_price: positive(context.midPx, "mid price"), open_interest: nonNegative(context.openInterest, "open interest"),
        day_volume: nonNegative(context.dayNtlVlm, "day volume") });
    } catch {
      // Reject only the invalid asset; valid peers in the same DEX remain usable.
    }
  });
  return rows;
}
async function postWithRetry(dex: string, fetchImpl: typeof fetch, retries: number): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImpl(INFO_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs", dex }), signal: AbortSignal.timeout(8_000) });
      if (response.ok) return await response.json();
      if ((response.status !== 429 && response.status < 500) || attempt >= retries) throw new Error(`Hyperliquid returned ${response.status}`);
    } catch (error) { if (attempt >= retries) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt + Math.random() * 50));
  }
}
export async function fetchMarketBatches(assets: AssetRequest[], bucket: Date, fetchImpl: typeof fetch = fetch, retries = 2): Promise<Map<string, DexResult>> {
  const groups = new Map<string, Set<string>>();
  assets.forEach(({ asset, dex }) => { if (!groups.has(dex)) groups.set(dex, new Set()); groups.get(dex)!.add(asset); });
  const results: Array<[string, DexResult]> = await Promise.all([...groups].map(async ([dex, requested]): Promise<[string, DexResult]> => {
    try { return [dex, { ok: true, observations: normalizeDexContext(dex, await postWithRetry(dex, fetchImpl, retries), requested, bucket) }]; }
    catch (error) { return [dex, { ok: false, error: error instanceof Error ? error.message : String(error) }]; }
  }));
  return new Map(results);
}
