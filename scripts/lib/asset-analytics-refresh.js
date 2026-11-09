export function collectMarketCatalogResults(results, labels = ["native", "xyz"]) {
  const markets = [];
  const failures = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") markets.push(...result.value);
    else failures.push(`${labels[index] ?? `dex ${index}`}: ${result.reason?.message ?? String(result.reason)}`);
  });
  return { markets, failures };
}

export async function discoverAnalyticsDexes(fetchDexNames, onFallback = () => {}) {
  try {
    return await fetchDexNames();
  } catch (error) {
    onFallback(error);
    return ["", "xyz"];
  }
}

export function analyticsShardAssets(markets, shardIndex, shardCount) {
  const assets = [...new Set(markets
    .filter((market) => !market.isDelisted)
    .map((market) => market.id))]
    .sort();
  return {
    assets,
    shardAssets: assets.filter((_, index) => index % shardCount === shardIndex),
  };
}

export function analyticsCacheUrl(restUrl, shardAssets) {
  const url = new URL(restUrl);
  url.searchParams.set("select", "asset,average_daily_volume,average_volume_updated_at,first_seen_at");
  url.searchParams.set("asset", `in.(${shardAssets.join(",")})`);
  return url;
}

// Reserve conservative API weight before each analytics request. Multiple assets
// share one queue, including retries, so background refresh leaves live work room.
export function analyticsRequestWeight(body) {
  if (body?.type !== "candleSnapshot") return 20;
  const intervals = { "5m":300000, "1h":3600000, "1d":86400000 };
  const interval = intervals[body.req?.interval];
  const rows = interval ? Math.min(5000, Math.ceil((body.req.endTime-body.req.startTime)/interval)+1) : 5000;
  return 20 + Math.ceil(Math.max(0,rows)/60);
}
export function createAnalyticsRequestGate(millisecondsPerWeight = 300) {
  let nextAt = 0;
  return (body, now = Date.now()) => {
    const start = Math.max(now,nextAt);
    nextAt = start+analyticsRequestWeight(body)*millisecondsPerWeight;
    return start-now;
  };
}
