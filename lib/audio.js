export function listenerAssetCatalog(watchlist, remembered, catalog) {
  const marketById = new Map(catalog.map((market) => [market.id, market]));
  return [...new Set([...watchlist, ...remembered])]
    .map((id) => marketById.get(id))
    .filter(Boolean);
}

export function audioStreamUrl(baseUrl, assetId, session = Date.now()) {
  const url = new URL(baseUrl);
  url.searchParams.set("asset", assetId);
  url.searchParams.set("session", String(session));
  return url.toString();
}
