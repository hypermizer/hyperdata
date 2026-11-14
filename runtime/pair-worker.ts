import { createServiceClient } from "../supabase/functions/_shared/database.ts";
import { sendNtfy } from "../supabase/functions/deliver-alerts/ntfy.ts";
import {
  normalizePair,
  pairAccountState,
  pairValuation,
} from "../public/lib/pair-trade.js";
const client = createServiceClient(
  Deno.env.get("LOCAL_DATA_URL")!,
  Deno.env.get("LOCAL_SERVICE_TOKEN")!,
);
let stopped = false,
  socket: WebSocket | null = null,
  wanted = new Set<string>(),
  retryAt = 0,
  backoff = 1000,
  lastMessage = 0,
  lastPing = 0;
const marks = new Map<
  string,
  {
    asset: string;
    mark_price: string;
    oracle_price: string | null;
    funding_rate: string | null;
    observed_at: string;
  }
>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rpc = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.rpc(name, args);
  if (r.error) throw Error(r.error.message);
  return r.data;
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => {
    stopped = true;
    socket?.close();
  });
}
function connect() {
  if (stopped || socket || !wanted.size || Date.now() < retryAt) return;
  const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
  socket = ws;
  lastMessage = Date.now();
  ws.onopen = () => {
    for (const asset of wanted) {
      ws.send(
        JSON.stringify({
          method: "subscribe",
          subscription: { type: "activeAssetCtx", coin: asset },
        }),
      );
    }
  };
  ws.onmessage = ({ data }) => {
    try {
      const value = JSON.parse(String(data));
      lastMessage = Date.now();
      backoff = 1000;
      if (value.channel !== "activeAssetCtx" || !wanted.has(value.data?.coin)) {
        return;
      }
      const ctx = value.data.ctx;
      if (!Number.isFinite(Number(ctx.markPx)) || Number(ctx.markPx) <= 0) {
        return;
      }
      marks.set(value.data.coin, {
        asset: value.data.coin,
        mark_price: String(ctx.markPx),
        oracle_price: ctx.oraclePx ?? null,
        funding_rate: ctx.funding ?? null,
        observed_at: new Date().toISOString(),
      });
    } catch { /* invalid data cannot become a valuation */ }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    retryAt = Date.now() + backoff;
    backoff = Math.min(30000, backoff * 2);
  };
  ws.onerror = () => ws.close();
}
async function refreshMarks() {
  const dexes = new Set(
    [...wanted].map((asset) => asset.includes(":") ? asset.split(":")[0] : ""),
  );
  for (const dex of dexes) {
    if (
      ![...wanted].some((asset) =>
        (asset.includes(":") ? asset.split(":")[0] : "") === dex &&
        (!marks.has(asset) ||
          Date.now() - Date.parse(marks.get(asset)!.observed_at) > 10000)
      )
    ) continue;
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", dex }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) continue;
    const body = await response.json();
    if (
      !Array.isArray(body) || !Array.isArray(body[0]?.universe) ||
      !Array.isArray(body[1])
    ) continue;
    for (let i = 0; i < body[0].universe.length; i++) {
      const name = body[0].universe[i].name,
        asset = name.includes(":") || !dex ? name : dex + ":" + name,
        ctx = body[1][i];
      if (
        !wanted.has(asset) || !ctx || !Number.isFinite(Number(ctx.markPx)) ||
        Number(ctx.markPx) <= 0
      ) continue;
      marks.set(asset, {
        asset,
        mark_price: String(ctx.markPx),
        oracle_price: ctx.oraclePx ?? null,
        funding_rate: ctx.funding ?? null,
        observed_at: new Date().toISOString(),
      });
    }
  }
}
async function refreshAccounts(pairs: any[]) {
  const sources = await client.from("hyperliquid_account_sources").select(
    "user_id,address",
  ).eq("active", true);
  if (sources.error) throw sources.error;
  for (const source of sources.data ?? []) {
    const dexes = new Set(
      pairs.filter((p) =>
        p.user_id === source.user_id && p.config.source === "account"
      ).flatMap((p) => [p.config.assetA, p.config.assetB]).map((
        asset: string,
      ) => asset.includes(":") ? asset.split(":")[0] : ""),
    );
    for (const dex of dexes) {
      const response = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "clearinghouseState",
          user: source.address,
          dex,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (!Array.isArray(body.assetPositions)) continue;
      const positions = body.assetPositions.map((row: any) => {
        const p = row.position;
        return {
          asset: p.coin.includes(":") || !dex ? p.coin : dex + ":" + p.coin,
          signed_size: p.szi,
          entry_price: p.entryPx,
          unrealized_pnl: p.unrealizedPnl,
          position_value: p.positionValue,
          margin_used: p.marginUsed,
          liquidation_price: p.liquidationPx,
          leverage_type: p.leverage.type,
          leverage: p.leverage.value,
          observed_at: new Date().toISOString(),
        };
      });
      const result = await client.from("pair_live_accounts").upsert({
        user_id: source.user_id,
        dex,
        positions,
        summary: body.marginSummary ?? {},
        observed_at: new Date().toISOString(),
      }, { onConflict: "user_id,dex" });
      if (result.error) throw result.error;
    }
  }
}
async function accountSnapshot(pair: any) {
  const snapshot = await rpc("pair_account_snapshot", {
    p_assets: [pair.config.assetA, pair.config.assetB],
    p_user: pair.user_id,
  });
  const state = pairAccountState(snapshot);
  // Live position and imported accounting must both be fresh before alerts.
  state.accountFresh &&= [pair.config.assetA, pair.config.assetB].every((
    asset: string,
  ) => state.freshDexes.has(asset.includes(":") ? asset.split(":")[0] : ""));
  return state;
}
async function historyJob() {
  const jobs = await rpc("claim_comparison_history");
  const job = jobs?.[0];
  if (!job) return;
  try {
    const key = Deno.env.get("OXARCHIVE_API_KEY");
    if (!key) throw Error("Historical provider is not configured");
    const rows: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 8; page++) {
      if (!await rpc("reserve_mark_archive_request")) {
        throw Error(
          "Historical request budget is reserved for market-data recovery",
        );
      }
      const url = new URL(
        "https://api.0xarchive.io/v1/hyperliquid/" +
          (job.asset.includes(":") ? "hip3/" : "") + "candles/" +
          encodeURIComponent(job.asset),
      );
      for (
        const [k, v] of Object.entries({
          start: job.start_ms,
          end: job.end_ms,
          interval: job.interval,
          limit: 10000,
        })
      ) url.searchParams.set(k, String(v));
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, {
        headers: { "X-API-Key": key, "0xArchive-Version": "2026-10-01" },
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      });
      if (response.status === 403) {
        throw Error(
          "HISTORY_ACCESS: The current archive plan is limited to 30 days. Exact older data needs full-history access or the public Hyperliquid archive; no substitute baseline has been used.",
        );
      }
      if (!response.ok) {
        throw Error("Historical provider returned " + response.status);
      }
      const body = await response.json();
      if (
        body.success !== true || !Array.isArray(body.data) ||
        body.meta?.symbol !== job.asset
      ) throw Error("Historical response could not be verified");
      for (const row of body.data) {
        const t = Date.parse(row.timestamp);
        if (
          !Number.isFinite(t) || t < Number(job.start_ms) ||
          t > Number(job.end_ms) ||
          ![row.open, row.high, row.low, row.close, row.volume].every((v) =>
            Number.isFinite(Number(v))
          ) || Number(row.close) <= 0
        ) throw Error("Invalid historical candle");
        rows.push({
          time: t / 1000,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
          trades: Number(row.trade_count ?? 0),
        });
      }
      if (!body.meta?.has_more) {
        cursor = null;
        break;
      }
      if (
        typeof body.meta.next_cursor !== "string" ||
        body.meta.next_cursor === cursor
      ) throw Error("Historical pagination could not be verified");
      cursor = body.meta.next_cursor;
      await sleep(200);
    }
    if (cursor) throw Error("Choose a coarser history interval");
    await client.from("comparison_history_cache").update({
      state: "ready",
      data: rows,
      source: "0xarchive_trade_candles",
      error: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    }).eq("key", job.key);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Historical data unavailable";
    await client.from("comparison_history_cache").update({
      state: message.startsWith("HISTORY_ACCESS") ? "blocked" : "error",
      error: message,
      lease_until: null,
      updated_at: new Date().toISOString(),
    }).eq("key", job.key);
  }
}
const getSocket = (): WebSocket | null => socket;
const seededPairs = new Set<string>();
let seedBusy = false, lastSeed = 0;
let accountBusy = false,
  historyBusy = false,
  marksBusy = false,
  lastHttpMarks = 0;
let pairs: any[] = [],
  lastRefresh = 0,
  lastAccounts = 0,
  lastEvaluate = 0,
  lastHistory = 0,
  lastDrain = 0,
  accountCache = new Map<string, any>();
while (!stopped) {
  try {
    if (Date.now() - lastRefresh > 5000) {
      const result = await client.from("pair_trades").select("*").eq(
        "archived",
        false,
      );
      if (result.error) throw result.error;
      pairs = result.data ?? [];
      const next = new Set<string>(
        pairs.flatMap((p) => [p.config.assetA, p.config.assetB]),
      );
      if ([...next].join() !== [...wanted].join()) {
        wanted = next;
        const previous = getSocket();
        socket = null;
        previous?.close();
      }
      lastRefresh = Date.now();
    }
    if (
      !seedBusy && Date.now() - lastSeed > 60000 &&
      pairs.some((pair) => !seededPairs.has(pair.id))
    ) {
      seedBusy = true;
      lastSeed = Date.now();
      void (async () => {
        for (const pair of pairs) {
          if (!seededPairs.has(pair.id)) {
            await rpc("seed_pair_marks", {
              p_assets: [pair.config.assetA, pair.config.assetB],
              p_start: new Date(pair.config.openedAt).toISOString(),
            });
            seededPairs.add(pair.id);
          }
        }
      })().catch(() => console.error("Pair mark backfill unavailable")).finally(
        () => {
          seedBusy = false;
        },
      );
    }
    connect();
    const current = getSocket();
    if (current && Date.now() - lastMessage > 60000) {
      socket = null;
      current.close();
    }
    if (
      current?.readyState === WebSocket.OPEN && Date.now() - lastPing > 20000
    ) {
      current.send(JSON.stringify({ method: "ping" }));
      lastPing = Date.now();
    }
    if (!marksBusy && Date.now() - lastHttpMarks > 15000) {
      marksBusy = true;
      lastHttpMarks = Date.now();
      void refreshMarks().catch(() =>
        console.error("Mark HTTP recovery unavailable")
      ).finally(() => {
        marksBusy = false;
      });
    }
    if (!accountBusy && Date.now() - lastAccounts > 10000) {
      accountBusy = true;
      lastAccounts = Date.now();
      void (async () => {
        await refreshAccounts(pairs);
        const next = new Map();
        for (const p of pairs.filter((p) => p.config.source === "account")) {
          next.set(p.id, await accountSnapshot(p));
        }
        accountCache = next;
      })().catch(() => {
        console.error("Pair account refresh unavailable");
        accountCache.clear();
      }).finally(() => {
        accountBusy = false;
      });
    }
    if (Date.now() - lastEvaluate > 1000) {
      if (marks.size) {
        const result = await client.from("pair_mark_quotes").upsert([
          ...marks.values(),
        ], { onConflict: "asset" });
        if (result.error) throw result.error;
        const samples = [...marks.values()].filter((q) =>
          wanted.has(q.asset) && Date.now() - Date.parse(q.observed_at) < 15000
        ).map((q) => ({
          asset: q.asset,
          bucket: new Date(
            Math.floor(Date.parse(q.observed_at) / 15000) * 15000,
          ).toISOString(),
          observed_at: q.observed_at,
          price: q.mark_price,
          source: "hyperliquid_mark",
        }));
        if (samples.length) {
          const saved = await client.from("pair_mark_samples").upsert(samples, {
            onConflict: "asset,bucket",
          });
          if (saved.error) throw saved.error;
        }
      }
      for (const row of pairs) {
        try {
          const pair = normalizePair(row.config);
          if (!Object.keys(pair.alerts).length) continue;
          const assets = [pair.assetA, pair.assetB];
          const fresh = assets.every((asset) =>
            marks.has(asset) &&
            Date.now() - Date.parse(marks.get(asset)!.observed_at) < 15000
          );
          if (!fresh) continue;
          const value = pairValuation(
            pair,
            Object.fromEntries(
              assets.map((a) => [a, marks.get(a)!.mark_price]),
            ),
            { ...(accountCache.get(row.id) ?? {}), marksFresh: fresh },
          );
          if (
            !value.fresh ||
            pair.source === "account" && Date.now() - lastAccounts > 30000
          ) continue;
          for (const [metric, threshold] of Object.entries(pair.alerts)) {
            let amount: number | null = null, breached = false;
            if (metric === "profit" || metric === "loss") {
              if (value.net === null) continue;
              amount = Number(value.net);
              breached = metric === "profit"
                ? amount >= Number(threshold)
                : amount <= -Number(threshold);
            } else if (metric === "exposure") {
              amount = value.exposurePercent === null
                ? null
                : Math.abs(Number(value.exposurePercent));
              breached = amount !== null && amount >= Number(threshold);
            } else {
              amount = value.liquidationBuffer === null
                ? null
                : Number(value.liquidationBuffer);
              breached = amount !== null && amount <= Number(threshold);
            }
            if (amount !== null) {
              await rpc("observe_pair_alert", {
                p_pair: row.id,
                p_metric: metric,
                p_breached: breached,
                p_message:
                  `${pair.name}: ${metric} threshold crossed. Observed ${
                    amount.toFixed(2)
                  }${
                    metric === "profit" || metric === "loss" ? " USD" : "%"
                  }. Threshold ${threshold}.`,
              });
            }
          }
        } catch {
          console.error("Pair valuation not reconciled; alerts withheld");
        }
      }
      lastEvaluate = Date.now();
    }
    if (Date.now() - lastDrain > 1000) {
      for (const notice of await rpc("claim_pair_alerts")) {
        let error: string | null = null;
        try {
          await sendNtfy({
            baseUrl: Deno.env.get("NTFY_BASE_URL")!,
            topic: Deno.env.get("NTFY_TOPIC")!,
            token: Deno.env.get("NTFY_TOKEN"),
            clickUrl: "https://dev-mini-ohio.tail628a67.ts.net:8446/#/compare",
          }, { subject: "HYPERDATA · pair trade", text: notice.message });
        } catch {
          error = "ntfy acceptance unconfirmed; retry scheduled";
        }
        await rpc("finish_pair_alert", {
          p_id: notice.id,
          p_lease: notice.lease_token,
          p_error: error,
        });
      }
      lastDrain = Date.now();
    }
    if (!historyBusy && Date.now() - lastHistory > 1000) {
      historyBusy = true;
      lastHistory = Date.now();
      void historyJob().catch(() =>
        console.error("Historical queue unavailable")
      ).finally(() => {
        historyBusy = false;
      });
    }
  } catch (error) {
    console.error(
      "Pair monitor:",
      error instanceof Error ? error.name : "unavailable",
    );
    await sleep(5000);
  }
  await sleep(200);
}
