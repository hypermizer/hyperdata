import { fetchAllMarkets } from "./hyperliquid.js?v=20260722-position-controls";

let catalogPromise;

export function getMarketCatalog() {
  catalogPromise ??= fetchAllMarkets()
    .then(requireAssetUniverseDexes)
    .then((markets) => markets.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.id.localeCompare(right.id)))
    .catch((error) => {
      catalogPromise = null;
      throw error;
    });
  return catalogPromise;
}

export function requireAssetUniverseDexes(markets) {
  const missing = [];
  if (!markets.some(({ dexId }) => dexId === "")) missing.push("native crypto");
  if (!markets.some(({ dexId }) => dexId === "xyz")) missing.push("TradFi");
  if (missing.length) throw new Error(`Hyperliquid ${missing.join(" and ")} catalog unavailable; retrying.`);
  return markets;
}
