const cache = new Map();
const CACHE_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

export async function fetchAssetFundamentals(client, asset, now = Date.now()) {
  const cached = cache.get(asset);
  if (cached && cached.expiresAt > now) return cached.data;
  if (!client?.functions) throw new Error("Financial data service unavailable.");
  const { data, error } = await client.functions.invoke("asset-fundamentals", { body: { asset } });
  if (error) {
    if (cached?.data) return { ...cached.data, stale: true };
    throw new Error(await functionErrorMessage(error, "Financial data service unavailable."));
  }
  if (!data || typeof data !== "object" || typeof data.identity?.displayName !== "string") {
    throw new Error("Financial data service returned invalid data.");
  }
  const normalized = {
    identity: {
      displayName: data.identity.displayName,
      description: String(data.identity.description || ""),
      yahooSymbol: data.identity.yahooSymbol ? String(data.identity.yahooSymbol) : null,
      instrumentType: String(data.identity.instrumentType || ""),
      exchange: String(data.identity.exchange || ""),
      source: String(data.identity.source || ""),
    },
    currency: String(data.currency || ""),
    updatedAt: data.updatedAt ? String(data.updatedAt) : null,
    metrics: Array.isArray(data.metrics) ? data.metrics : [],
    quarters: Array.isArray(data.quarters) ? data.quarters : [],
    available: Boolean(data.available),
  };
  if (!cache.has(asset) && cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(asset, { expiresAt: now + CACHE_MS, data: normalized });
  return normalized;
}

export async function functionErrorMessage(error, fallback) {
  try {
    const response = error?.context;
    if (response instanceof Response) {
      const payload = await response.clone().json();
      if (payload?.detail) return String(payload.detail);
      if (payload?.error) return String(payload.error).replaceAll("_", " ");
    }
  } catch { /* use the SDK message */ }
  const message = String(error?.message || "");
  return /non-2xx/i.test(message) ? fallback : (message || fallback);
}
