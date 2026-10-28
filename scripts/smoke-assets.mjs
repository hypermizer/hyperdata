#!/usr/bin/env node

import { APP_CONFIG } from "../public/config.js";
import { fetchAllMarkets } from "../public/lib/hyperliquid.js";

const ORIGIN = "https://hypermizer.github.io";
const MINIMUM_EXPECTED_MARKETS = 100;
const markets = await fetchAllMarkets(fetch, { requireAnnotations: true, requireComplete: true });
if (markets.length < MINIMUM_EXPECTED_MARKETS) {
  throw new Error(`Hyperliquid catalog unexpectedly contains only ${markets.length} markets`);
}

const providers = new Map();
for (const market of markets) {
  const venue = market.dexId || "native";
  if (!providers.has(venue)) providers.set(venue, market.id);
}

for (const venue of ["native", "xyz", "para", "mkts", "io"]) {
  const asset = providers.get(venue);
  if (!asset) continue;
  for (const functionName of ["asset-fundamentals", "asset-news"]) {
    const response = await fetch(`${APP_CONFIG.supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        apikey: APP_CONFIG.supabasePublishableKey,
        authorization: `Bearer ${APP_CONFIG.supabasePublishableKey}`,
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: JSON.stringify({ asset }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${functionName} rejected ${asset} (${response.status}): ${payload.detail || payload.error || "unknown error"}`);
    }
  }
}

console.log(JSON.stringify({ markets: markets.length, venues: providers.size, checked: [...providers.entries()] }, null, 2));
