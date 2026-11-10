import { createServiceClient } from "../supabase/functions/_shared/database.ts";
import { infoRequest } from "../supabase/functions/_shared/hyperliquid.ts";
import {
  candleHistoryPoints,
  historyCatalog,
  historyFrameExtendsCatalog,
  historySamples,
  repairRequestWeight,
} from "./market-history-data.ts";

const client = createServiceClient(
  Deno.env.get("LOCAL_DATA_URL")!,
  Deno.env.get("LOCAL_SERVICE_TOKEN")!,
);
let stopped = false,
  socket: WebSocket | null = null,
  connected = false,
  lastFrame = 0,
  lastPersisted: string | null = null;
let catalog: ReturnType<typeof historyCatalog> = [],
  catalogAt = 0,
  reconnectAt = 0,
  nextRequestAt = 0,
  persistBusy = false,
  repairBusy = false;
let lastError: string | null = null;
let catalogRetryAt = 0;
let lastCoverageScan = 0, coverageBusy = false;
const contexts = new Map<string, { price: string; at: number }>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw Error(name + ": " + error.message);
  return data;
}
async function limitedInfo(body: Record<string, unknown>) {
  const now = Date.now(), start = Math.max(now, nextRequestAt);
  nextRequestAt = start + repairRequestWeight(body) * 100; // at most 600 weight/min, including metadata and retries
  if (start > now) await sleep(start - now);
  return await infoRequest(body, fetch, 0);
}
async function loadCatalog() {
  const dexes = await limitedInfo({ type: "perpDexs" });
  const metas = await limitedInfo({ type: "allPerpMetas" });
  catalog = historyCatalog(dexes, metas);
  await rpc("sync_mark_history_assets", {
    p_assets: catalog.map((a) => ({ asset: a.asset, dex: a.dex })),
  });
  catalogAt = Date.now();
  catalogRetryAt = Date.now() + 30000;
  console.log(
    JSON.stringify({ event: "history_catalog", assets: catalog.length }),
  );
}
function connect() {
  if (stopped || socket) return;
  const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
  socket = ws;
  const timeout = setTimeout(() => ws.close(), 10_000);
  ws.onopen = () => {
    clearTimeout(timeout);
    connected = true;
    lastFrame = Date.now();
    ws.send(
      JSON.stringify({
        method: "subscribe",
        subscription: { type: "allDexsAssetCtxs" },
      }),
    );
  };
  ws.onmessage = (e) => {
    if (socket !== ws) return;
    try {
      const message = JSON.parse(String(e.data));
      if (message.channel !== "allDexsAssetCtxs") return;
      if (historyFrameExtendsCatalog(message.data, catalog)) catalogAt = 0;
      const at = Date.now();
      for (const sample of historySamples(message.data, catalog)) {
        contexts.set(sample.asset, { price: sample.price, at });
      }
      lastFrame = at;
    } catch {
      lastError = "Malformed market history frame";
    }
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    clearTimeout(timeout);
    if (socket === ws) {
      socket = null;
      connected = false;
      reconnectAt = Date.now() + 3000;
    }
  };
}
async function persist() {
  if (persistBusy) return;
  persistBusy = true;
  try {
    // Queue any downtime gap before appending a fresh sample, which would otherwise
    // hide the gap when the repair worker looks at the newest persisted timestamp.
    await rpc("queue_asset_history_repairs", {
      p_assets: catalog.map((a) => a.asset),
    });
    const now = Date.now();
    const samples = [...contexts].filter(([, v]) => now - v.at < 15_000).map((
      [asset, v],
    ) => ({ asset, price: v.price }));
    if (samples.length) {
      await rpc("record_asset_price_samples", {
        p_bucket: new Date(now).toISOString(),
        p_samples: samples,
      });
      await rpc("record_live_mark_batch", {
        p_observed_at: new Date(now).toISOString(),
        p_samples: samples,
      });
      lastPersisted = new Date(now).toISOString();
    }
    const { data: pending, error: pendingError } = await client.from(
      "market_history_repair_queue",
    ).select("asset,watched").in("asset", catalog.map((a) => a.asset));
    if (pendingError) throw Error(pendingError.message);
    const { error } = await client.from("market_history_state").update({
      repairs_pending: pending?.length ?? 0,
      watched_repairs_pending: pending?.filter((r) => r.watched).length ?? 0,
      heartbeat_at: new Date().toISOString(),
      last_frame_at: lastFrame ? new Date(lastFrame).toISOString() : null,
      last_persisted_at: lastPersisted,
      assets_sampled: samples.length,
      assets_expected: catalog.length,
      connected,
      last_error: lastError,
    }).eq("singleton", true);
    if (error) throw Error(error.message);
  } catch (e) {
    lastError = e instanceof Error ? e.message : "Market persistence failed";
    console.error(lastError);
  } finally {
    persistBusy = false;
  }
}
async function repair() {
  if (repairBusy) return;
  repairBusy = true;
  try {
    const { data, error } = await client.from("market_history_repair_queue")
      .select("asset,from_ms,watched")
      .in("asset", catalog.map((a) => a.asset)).lte(
        "retry_after",
        new Date().toISOString(),
      ).order("asset").limit(1);
    if (error) throw Error(error.message);
    const job = data?.[0];
    if (!job) return;
    try {
      const now = Date.now(),
        body = {
          type: "candleSnapshot",
          req: {
            coin: job.asset,
            interval: "5m",
            startTime: Math.max(now - 7 * 86400000, Number(job.from_ms)),
            endTime: now,
          },
        };
      const candles = await limitedInfo(body);
      const points = candleHistoryPoints(candles, now);
      await rpc("merge_asset_price_history", {
        p_asset: job.asset,
        p_points: points,
        p_observed_at: new Date().toISOString(),
      });
      lastError = null;
      console.log(
        JSON.stringify({
          event: "history_repaired",
          asset: job.asset,
          points: points.length,
          watched: job.watched,
        }),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "History repair failed";
      lastError = message;
      await client.from("market_history_backfills").update({
        last_error: message,
        retry_after: new Date(Date.now() + 60_000).toISOString(),
      }).eq("asset", job.asset);
      console.error(
        JSON.stringify({
          event: "history_repair_retry",
          asset: job.asset,
          error: message,
        }),
      );
      if (message.includes("429")) {
        nextRequestAt = Math.max(nextRequestAt, Date.now() + 30_000);
      }
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : "History queue unavailable");
  } finally {
    repairBusy = false;
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => {
    stopped = true;
    socket?.close();
  });
}
while (!stopped) {
  if (
    Date.now() >= catalogRetryAt &&
    (!catalog.length || Date.now() - catalogAt > 300000)
  ) {
    try {
      await loadCatalog();
    } catch (e) {
      console.error(e);
      catalogRetryAt = Date.now() + 30000;
    }
  }
  if (!catalog.length) {
    await sleep(1000);
    continue;
  }
  if (!socket && Date.now() >= reconnectAt) connect();
  const activeSocket = socket as WebSocket | null;
  if (
    activeSocket?.readyState === WebSocket.OPEN &&
    Date.now() - lastFrame > 30000
  ) {
    activeSocket.close();
  }
  if (
    activeSocket?.readyState === WebSocket.OPEN && Date.now() % 30000 < 1100
  ) {
    activeSocket.send(JSON.stringify({ method: "ping" }));
  }
  if (!lastPersisted || Date.now() - Date.parse(lastPersisted) >= 60000) {
    void persist();
  }
  void repair();
  if (!coverageBusy && Date.now() - lastCoverageScan > 15000) {
    coverageBusy = true;
    void rpc("refresh_mark_reference_coverage").then(() => {
      lastCoverageScan = Date.now();
    }).catch(console.error).finally(() => {
      coverageBusy = false;
    });
  }
  await sleep(1000);
}
while (persistBusy || repairBusy) await sleep(100);
