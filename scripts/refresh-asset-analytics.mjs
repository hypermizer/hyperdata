import { fetchAverageDailyVolume, fetchMarketsForDex, fetchPriceHistory } from "../public/lib/hyperliquid.js";

const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_ID;
const shardIndex = Number(process.env.ANALYTICS_SHARD_INDEX);
const shardCount = Number(process.env.ANALYTICS_SHARD_COUNT);
if (!accessToken || !projectRef || !Number.isInteger(shardIndex) || !Number.isInteger(shardCount)
  || shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
  throw new Error("Valid SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_ID, ANALYTICS_SHARD_INDEX, and ANALYTICS_SHARD_COUNT are required");
}

const managementHeaders = { authorization: `Bearer ${accessToken}` };
const keysResponse = await fetchWithRetry(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/api-keys`, {
  headers: managementHeaders,
});
if (!keysResponse.ok) throw new Error(`Unable to retrieve project API keys (${keysResponse.status})`);
const keys = await keysResponse.json();
const serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key;
if (!serviceRoleKey) throw new Error("Project service-role key was unavailable");

const restHeaders = {
  apikey: serviceRoleKey,
  authorization: `Bearer ${serviceRoleKey}`,
  "content-type": "application/json",
};
const restUrl = `https://${projectRef}.supabase.co/rest/v1/asset_analytics_cache`;
const existingResponse = await fetchWithRetry(`${restUrl}?select=asset,average_daily_volume,average_volume_updated_at,first_seen_at`, { headers: restHeaders });
if (!existingResponse.ok) throw new Error(`Unable to read analytics cache (${existingResponse.status})`);
const existing = new Map((await existingResponse.json()).map((row) => [row.asset, row]));

const markets = await fetchMarketsForDex("xyz", fetchWithRetry);
const assets = markets.filter((market) => !market.isDelisted).map((market) => market.id).sort();
const shardAssets = assets.filter((_, index) => index % shardCount === shardIndex);
const now = Date.now();
const failures = [];
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
    return {
      asset,
      first_seen_at: cached?.first_seen_at ?? new Date(history[0].time).toISOString(),
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
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
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
