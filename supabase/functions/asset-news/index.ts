import { allowedBrowserOrigin, browserCors } from "../_shared/browser-origins.ts";
import { resolveAssetIdentity } from "../_shared/asset-identity.ts";
import { buildGoogleNewsSearchUrl, buildNewsQueries, buildNewsSearchUrl, parseNewsFeed, rankAndDeduplicateNews, type NewsItem } from "./feed.ts";
import { handleAssetNews } from "./handler.ts";

const CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const cache = new Map<string, { expiresAt: number; items: NewsItem[] }>();


async function fetchNews(asset: string): Promise<NewsItem[]> {
  const cached = cache.get(asset);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const identity = await resolveAssetIdentity(asset, { includeDescription: false });
  const searches = buildNewsQueries(asset, identity).slice(0, 6).flatMap((query) => [
    buildNewsSearchUrl(query),
    buildGoogleNewsSearchUrl(query),
  ]);
  const results = await Promise.allSettled(searches.map(async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`news provider returned ${response.status}`);
    return parseNewsFeed(await response.text());
  }));
  const successful = results.filter((result): result is PromiseFulfilledResult<NewsItem[]> => result.status === "fulfilled");
  if (!successful.length) throw new Error("all news queries failed");
  const items = rankAndDeduplicateNews(successful.flatMap((result) => result.value), identity);
  if (!cache.has(asset) && cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(asset, { expiresAt: Date.now() + CACHE_MS, items });
  return items;
}

export async function serveAssetNews(request: Request): Promise<Response> {
  const origin = allowedBrowserOrigin(request);
  if (!origin) return Response.json({ error: "forbidden_origin" }, { status: 403 });
  const corsHeaders = browserCors(origin);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const response = await handleAssetNews(request, { allowedOrigin: origin, fetchNews });
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

if (import.meta.main) Deno.serve(serveAssetNews);
