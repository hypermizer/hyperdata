import { fetchAverageDailyVolume, fetchDexNames, fetchMarketsForDex, fetchPriceHistory } from "../public/lib/hyperliquid.js";
import { earliestIsoTimestamp } from "../public/lib/asset-analytics.js";
import { analyticsCacheUrl, analyticsShardAssets, createAnalyticsRequestGate, collectMarketCatalogResults, discoverAnalyticsDexes } from "./lib/asset-analytics-refresh.js";

import { localDataFetch } from "./lib/local-data.js";
const shardCount = Number(process.env.ANALYTICS_SHARD_COUNT ?? 24);
const shardIndex = Number(process.env.ANALYTICS_SHARD_INDEX ?? new Date().getUTCHours() % shardCount);
const reserveMarketRequest = createAnalyticsRequestGate();
const serviceRoleKey = process.env.LOCAL_SERVICE_TOKEN;
if (!process.env.LOCAL_DATA_SOCKET || !serviceRoleKey || !Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
  throw new Error("Local data credentials and valid analytics shard configuration are required");
}
const localFetch = localDataFetch(process.env.LOCAL_DATA_SOCKET);
const restHeaders = {authorization:`Bearer ${serviceRoleKey}`,"content-type":"application/json"};
const restUrl = "http://local-data/rest/v1/asset_analytics_cache";
const failures = [];
const dexNames = await discoverAnalyticsDexes(
  () => fetchDexNames(fetchWithRetry),
  (error) => console.warn(`DEX discovery failed; using core DEXes: ${error.message}`),
);
const marketResults = await Promise.allSettled(
  dexNames.map((dex) => fetchMarketsForDex(dex, fetchWithRetry)),
);
const catalog = collectMarketCatalogResults(
  marketResults,
  dexNames.map((dex) => dex || "native"),
);
const markets = catalog.markets;
failures.push(...catalog.failures.map((failure) => `${failure} catalog`));
if (!markets.length) throw new Error(`Unable to discover analytics assets: ${failures.join("; ")}`);
const { assets, shardAssets } = analyticsShardAssets(markets, shardIndex, shardCount);
const cacheUrl = analyticsCacheUrl(restUrl, shardAssets);
const existingResponse = await fetchWithRetry(cacheUrl, { headers: restHeaders });
if (!existingResponse.ok) throw new Error(`Unable to read analytics cache (${existingResponse.status})`);
const existing = new Map((await existingResponse.json()).map((row) => [row.asset, row]));
const now = Date.now();
const rows = (await mapLimit(shardAssets, 3, async (asset) => {
  try {
    const cached = existing.get(asset);
    const averageIsFresh = cached?.average_volume_updated_at
      && now - Date.parse(cached.average_volume_updated_at) < 24 * 60 * 60 * 1000;
    const [history, average] = await Promise.all([
      fetchPriceHistory(asset, fetchWithRetry, now),
      averageIsFresh
        ? Promise.resolve(cached.average_daily_volume !== null && Number.isFinite(Number(cached.average_daily_volume))
          ? Number(cached.average_daily_volume)
          : null)
        : fetchAverageDailyVolume(asset, fetchWithRetry, now),
    ]);
    if (!history.length) throw new Error("no candle history returned");
    const historicalFirstSeen = new Date(history[0].time).toISOString();
    return {
      asset,
      first_seen_at: earliestIsoTimestamp(cached?.first_seen_at, historicalFirstSeen) ?? historicalFirstSeen,
      average_daily_volume: average,
      price_history: history,
      history_updated_at: new Date(now).toISOString(),
      average_volume_updated_at: averageIsFresh ? cached.average_volume_updated_at : new Date(now).toISOString(),
    };
  } catch (error) {
    failures.push(`${asset}: ${error.message}`);
    return null;
  }
})).filter(Boolean);

if (rows.length) {
  const upsertResponse = await fetchWithRetry(`${restUrl}?on_conflict=asset`, {
    method: "POST",
    headers: { ...restHeaders, prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!upsertResponse.ok) throw new Error(`Unable to write analytics cache (${upsertResponse.status}): ${(await upsertResponse.text()).slice(0, 300)}`);
}

console.log(`Analytics shard ${shardIndex + 1}/${shardCount}: cached ${rows.length}/${shardAssets.length} assets (${assets.length} total)`);
if (failures.length) throw new Error(`Analytics refresh failures: ${failures.join("; ")}`);

async function fetchWithRetry(url, options = {}) {
  let failure;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response;
    if (new URL(url).hostname === "api.hyperliquid.xyz") {
      const wait = reserveMarketRequest(JSON.parse(options.body));
      if (wait > 0) await delay(wait);
    }
    try {
      response = await localFetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      failure = error;
    }
    if (response) {
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) return response;
      failure = new Error(`HTTP ${response.status}`);
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader === null ? null : Number(retryAfterHeader);
      if (attempt < 4) await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * 2 ** attempt);
      continue;
    }
    if (attempt < 4) await delay(750 * 2 ** attempt);
  }
  throw failure ?? new Error("Request failed after retries");
}

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
