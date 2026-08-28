import { fetchAllMarkets } from "./hyperliquid.js?v=20260722-position-controls";

let catalogPromise;
let assetCatalogPromise;

export function getMarketCatalog() {
  catalogPromise ??= fetchAllMarkets().then(sortMarkets);
  return catalogPromise;
}

export function getAssetMarketCatalog() {
  assetCatalogPromise ??= fetchAllMarkets()
    .then(requireAssetUniverseDexes)
    .then(sortMarkets)
    .catch((error) => {
      assetCatalogPromise = null;
      throw error;
    });
  return assetCatalogPromise;
}

export function requireAssetUniverseDexes(markets) {
  const missing = [];
  if (!markets.some(({ dexId }) => dexId === "")) missing.push("native crypto");
  if (!markets.some(({ dexId }) => dexId === "xyz")) missing.push("TradFi");
  if (missing.length) throw new Error(`Hyperliquid ${missing.join(" and ")} catalog unavailable; retrying.`);
  return markets;
}

function sortMarkets(markets) {
  return markets.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.id.localeCompare(right.id));
}
