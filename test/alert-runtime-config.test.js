import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production fixed-price monitoring uses the free-tier fifteen-second cadence with a five-minute delivery fallback", async () => {
  const [migration, monitor, browserConfig] = await Promise.all([
    readFile(new URL("../supabase/migrations/202607310005_alert_latency.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/monitor-market/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/config.js", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /'hyperdata-monitor-market',\s*'15 seconds'/);
  assert.match(migration, /'hyperdata-deliver-alerts',\s*'\*\/5 \* \* \* \*'/);
  assert.match(monitor, /Promise\.allSettled\(\[/);
  assert.match(monitor, /config\.deliveryEnabled \? deliverPending\(client\) : Promise\.resolve\(\[\]\)/);
  assert.match(monitor, /isAnalyticsBucket\(bucket\) \? recordAssetAnalyticsSnapshot\(client, bucket\) : Promise\.resolve\(0\)/);
  assert.match(browserConfig, /alertsRefreshIntervalMs:\s*15_000/);
});
