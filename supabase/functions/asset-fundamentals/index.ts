import { allowedBrowserOrigin, browserCors } from "../_shared/browser-origins.ts";
import { resolveAssetIdentity } from "../_shared/asset-identity.ts";
import { fetchYahooFundamentals, type AssetFundamentals } from "./finance.ts";
import { handleAssetFundamentals } from "./handler.ts";

const CACHE_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const cache = new Map<string, { expiresAt: number; data: AssetFundamentals }>();


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
  const origin = allowedBrowserOrigin(request);
  if (!origin) return Response.json({ error: "forbidden_origin" }, { status: 403 });
  const corsHeaders = browserCors(origin);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const response = await handleAssetFundamentals(request, { allowedOrigin: origin, fetchFundamentals });
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

if (import.meta.main) Deno.serve(serveAssetFundamentals);
