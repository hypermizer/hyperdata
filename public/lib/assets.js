export function displayAssetSymbol(asset) {
  return String(asset?.symbol ?? asset?.id ?? "").replace(/^xyz:/i, "");
}

export function resolveAsset(catalog, value) {
  const query = String(value ?? "").trim().toLowerCase();
  if (!query) return null;
  const exactId = catalog.find((asset) => asset.id.toLowerCase() === query);
  if (exactId) return exactId;
  const symbols = catalog.filter((asset) => displayAssetSymbol(asset).toLowerCase() === query);
  return symbols.length === 1 ? symbols[0] : null;
}

export function searchAssets(catalog, value, limit = 10) {
  const query = String(value ?? "").trim().toLowerCase();
  return catalog
    .map((asset) => ({ asset, score: matchScore(asset, query) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || displayAssetSymbol(left.asset).localeCompare(displayAssetSymbol(right.asset)) || left.asset.id.localeCompare(right.asset.id))
    .slice(0, limit)
    .map(({ asset }) => asset);
}

function matchScore(asset, query) {
  if (!query) return 10;
  const id = asset.id.toLowerCase();
  const symbol = displayAssetSymbol(asset).toLowerCase();
  if (id === query) return 0;
  if (symbol === query) return 1;
  if (symbol.startsWith(query)) return 2 + (symbol.length - query.length) / 100;
  if (id.startsWith(query)) return 3 + (id.length - query.length) / 100;
  const symbolIndex = symbol.indexOf(query);
  if (symbolIndex >= 0) return 4 + symbolIndex / 10;
  const idIndex = id.indexOf(query);
  if (idIndex >= 0) return 5 + idIndex / 10;
  const distance = subsequenceDistance(symbol, query);
  return distance === null ? Infinity : 6 + distance / 100;
}

function subsequenceDistance(value, query) {
  let queryIndex = 0;
  let spread = 0;
  let previous = -1;
  for (let index = 0; index < value.length && queryIndex < query.length; index += 1) {
    if (value[index] !== query[queryIndex]) continue;
    if (previous >= 0) spread += index - previous - 1;
    previous = index;
    queryIndex += 1;
  }
  return queryIndex === query.length ? spread + value.length - query.length : null;
}
