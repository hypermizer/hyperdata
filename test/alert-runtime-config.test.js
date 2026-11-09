import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("independent backup monitoring and delivery retain a fifteen-second cadence", async () => {
  const [migration, monitor, browserConfig] = await Promise.all([
    readFile(new URL("../supabase/migrations/202611090001_realtime_price_alerts.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/monitor-market/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/config.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /'hyperdata-monitor-market',\s*'15 seconds'/);
  assert.match(migration, /'hyperdata-deliver-alerts',\s*'15 seconds'/);
  assert.match(monitor, /Promise\.allSettled\(\[/);
  assert.match(monitor, /config\.deliveryEnabled \? deliverPending\(client\) : Promise\.resolve\(\[\]\)/);
  assert.match(monitor, /isAnalyticsBucket\(bucket\) \? recordAssetAnalyticsSnapshot\(client, bucket\) : Promise\.resolve\(0\)/);
  assert.match(browserConfig, /alertsRefreshIntervalMs:\s*15_000/);
});
