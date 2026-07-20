import { fetchAllMarkets } from "./hyperliquid.js?v=20260722-order-ticket";

let catalogPromise;

export function getMarketCatalog() {
  catalogPromise ??= fetchAllMarkets().then((markets) => markets.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.id.localeCompare(right.id)));
  return catalogPromise;
}
