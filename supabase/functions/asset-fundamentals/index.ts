import { resolveAssetIdentity } from "../_shared/asset-identity.ts";
import { fetchYahooFundamentals, type AssetFundamentals } from "./finance.ts";
import { handleAssetFundamentals } from "./handler.ts";

const ALLOWED_ORIGIN = "https://hypermizer.github.io";
const CACHE_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const cache = new Map<string, { expiresAt: number; data: AssetFundamentals }>();
const corsHeaders = {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

async function fetchFundamentals(asset: string): Promise<AssetFundamentals> {
  const cached = cache.get(asset);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const identity = await resolveAssetIdentity(asset, { includeDescription: true });
  const data = await fetchYahooFundamentals(identity);
  if (!cache.has(asset) && cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(asset, { expiresAt: Date.now() + CACHE_MS, data });
  return data;
}

export async function serveAssetFundamentals(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const response = await handleAssetFundamentals(request, { allowedOrigin: ALLOWED_ORIGIN, fetchFundamentals });
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

if (import.meta.main) Deno.serve(serveAssetFundamentals);
