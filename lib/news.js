const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

export async function fetchAssetNews(client, asset, now = Date.now()) {
  const cached = cache.get(asset);
  if (cached && cached.expiresAt > now) return cached.items;
  if (!client?.functions) throw new Error("News service unavailable.");
  const { data, error } = await client.functions.invoke("asset-news", { body: { asset } });
  if (error) throw new Error(error.message || "News service unavailable.");
  if (!Array.isArray(data?.items)) throw new Error("News service returned invalid data.");
  const items = data.items.flatMap((item) => {
    const publishedAt = new Date(item?.publishedAt);
    try {
      const url = new URL(item?.url);
      if (!/^https?:$/.test(url.protocol) || !item?.title || Number.isNaN(publishedAt.getTime())) return [];
      return [{
        title: String(item.title),
        url: url.href,
        source: String(item.source || "Unknown"),
        publishedAt: publishedAt.toISOString(),
        topic: String(item.topic || "MARKET"),
        score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
      }];
    } catch {
      return [];
    }
  });
  if (!cache.has(asset) && cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(asset, { expiresAt: now + CACHE_MS, items });
  return items;
}
