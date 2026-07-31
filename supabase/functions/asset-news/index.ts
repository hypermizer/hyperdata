import { buildNewsQuery, parseNewsFeed, type NewsItem } from "./feed.ts";
import { handleAssetNews } from "./handler.ts";

const ALLOWED_ORIGIN = "https://hypermizer.github.io";
const CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const cache = new Map<string, { expiresAt: number; items: NewsItem[] }>();
const corsHeaders = {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

async function fetchNews(asset: string): Promise<NewsItem[]> {
  const cached = cache.get(asset);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", buildNewsQuery(asset));
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`news provider returned ${response.status}`);
  const items = parseNewsFeed(await response.text());
  if (!cache.has(asset) && cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(asset, { expiresAt: Date.now() + CACHE_MS, items });
  return items;
}

export async function serveAssetNews(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const response = await handleAssetNews(request, { allowedOrigin: ALLOWED_ORIGIN, fetchNews });
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

if (import.meta.main) Deno.serve(serveAssetNews);
