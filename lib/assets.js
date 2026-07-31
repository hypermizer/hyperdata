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

export function searchAssets(catalog, value, limit = Infinity) {
  const query = String(value ?? "").trim().toLowerCase();
  return catalog
    .map((asset) => ({ asset, score: matchScore(asset, query) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || displayAssetSymbol(left.asset).localeCompare(displayAssetSymbol(right.asset)) || left.asset.id.localeCompare(right.asset.id))
    .slice(0, limit)
    .map(({ asset }) => asset);
}

const MOVE_WINDOWS_MS = new Map([
  ["1w", 7 * 24 * 60 * 60 * 1000],
  ["1d", 24 * 60 * 60 * 1000],
  ["6h", 6 * 60 * 60 * 1000],
  ["1h", 60 * 60 * 1000],
  ["30m", 30 * 60 * 1000],
  ["10m", 10 * 60 * 1000],
  ["5m", 5 * 60 * 1000],
]);
const HOURS_PER_YEAR = 24 * 365;

export function annualizedFundingApr(hourlyFundingRate) {
  return Number.isFinite(hourlyFundingRate)
    ? hourlyFundingRate * HOURS_PER_YEAR * 100
    : null;
}

export function isTradFiMarket(market) {
  return market?.dexId === "xyz" && !market.isDelisted;
}

export function hydrateTradFiMarkets(catalog, marketsById) {
  return catalog
    .filter(isTradFiMarket)
    .map((market) => marketsById.get(market.id) ?? market);
}

export function nextColumnSort(currentSort, column) {
  return currentSort === `${column}-desc` ? `${column}-asc` : `${column}-desc`;
}

export function filterAndSortTradFiAssets(markets, options = {}) {
  const {
    averageVolumes = new Map(),
    now = Date.now(),
    priceHistories = new Map(),
    query = "",
    sort = "asset",
    watched = [],
    watchedFirst = false,
  } = options;
  const normalizedQuery = String(query).trim().toLowerCase();
  const watchedIds = new Set(watched);
  const filtered = markets.filter((market) => {
    if (!isTradFiMarket(market)) return false;
    if (!normalizedQuery) return true;
    return [market.symbol, market.id]
      .some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
  });
  const metric = metricSelector(sort, { averageVolumes, now, priceHistories });
  const direction = sort.endsWith("-asc") ? 1 : -1;
  const assetDirection = sort === "asset-desc" ? -1 : 1;

  return filtered.sort((left, right) => {
    if (watchedFirst) {
      const watchedOrder = Number(watchedIds.has(right.id)) - Number(watchedIds.has(left.id));
      if (watchedOrder) return watchedOrder;
    }
    if (metric) {
      const metricOrder = compareMetrics(metric(left), metric(right), direction);
      if (metricOrder) return metricOrder;
    }
    return assetDirection * (displayAssetSymbol(left).localeCompare(displayAssetSymbol(right)) || left.id.localeCompare(right.id));
  });
}

export function marketChangePercentForWindow(market, points, milliseconds, now = Date.now()) {
  if (!Number.isFinite(market?.markPrice) || market.markPrice <= 0) return null;
  const target = Number(now) - milliseconds;
  let reference = null;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].time <= target) {
      reference = points[index].price;
      break;
    }
  }
  return Number.isFinite(reference) && reference > 0
    ? (market.markPrice / reference - 1) * 100
    : null;
}

function metricSelector(sort, context) {
  if (sort.startsWith("mark-")) return (market) => market.markPrice;
  if (sort.startsWith("volume-")) return (market) => market.volume24h;
  if (sort.startsWith("avg-volume-")) return (market) => context.averageVolumes.get(market.id);
  if (sort.startsWith("open-interest-")) return (market) => market.openInterest;
  if (sort === "apr-desc" || sort === "apr-asc") return (market) => annualizedFundingApr(market.funding);
  if (sort === "change-24h-desc" || sort === "change-24h-asc") return (market) => market.changePercent;
  if (sort === "change-24h-abs") return (market) => absolute(market.changePercent);
  const moveMatch = /^move-(1w|1d|6h|1h|30m|10m|5m)-(asc|desc|abs)$/.exec(sort);
  if (moveMatch) {
    const [, window, order] = moveMatch;
    return (market) => {
      const change = marketChangePercentForWindow(
        market,
        context.priceHistories.get(market.id) ?? [],
        MOVE_WINDOWS_MS.get(window),
        context.now,
      );
      return order === "abs" ? absolute(change) : change;
    };
  }
  return null;
}

function compareMetrics(left, right, direction) {
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (!leftValid || !rightValid) return leftValid ? -1 : rightValid ? 1 : 0;
  return left === right ? 0 : (left - right) * direction;
}

function absolute(value) {
  return Number.isFinite(value) ? Math.abs(value) : null;
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
