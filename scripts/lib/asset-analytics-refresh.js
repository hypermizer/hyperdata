export function collectMarketCatalogResults(results, labels = ["native", "xyz"]) {
  const markets = [];
  const failures = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") markets.push(...result.value);
    else failures.push(`${labels[index] ?? `dex ${index}`}: ${result.reason?.message ?? String(result.reason)}`);
  });
  return { markets, failures };
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
