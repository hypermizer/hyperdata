import { AlertStore } from "./store.ts";
import {
  parseMarkFrame,
  PriceAlertEngine,
  type StreamRule,
} from "../scripts/price-stream/engine.ts";
import { readSpool, saveSpool } from "../scripts/price-stream/spool.ts";
import { drainDeliveries } from "./delivery.ts";
import { fetchMarketBatches } from "../supabase/functions/_shared/hyperliquid.ts";
import { evaluateLargeMove } from "../supabase/functions/_shared/detectors/large-move.ts";
import {
  buildBootstrapModel,
  fetchCalibrationCandles,
} from "../supabase/functions/rebuild-calibrations/bootstrap.ts";
import { updateVariance } from "../supabase/functions/_shared/statistics/robust-volatility.ts";
import { logReturn } from "../supabase/functions/_shared/statistics/returns.ts";
import type { MarketObservation } from "../supabase/functions/_shared/types.ts";

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fallbackCycle(store: AlertStore, bucket = new Date()) {
  if (!await store.active()) return;
  const rules = await store.activeRules();
  const assets = [
    ...new Map(
      rules.map((rule) => [rule.asset, { asset: rule.asset, dex: rule.dex }]),
    ).values(),
  ];
  const batches = await fetchMarketBatches(assets, bucket, fetch, 0);
  const observations: MarketObservation[] = [];
  const failures: string[] = [];
  for (const [dex, result] of batches) {
    if (result.ok) observations.push(...result.observations);
    else failures.push(dex || "main");
  }
  let occurrences = 0;
  const minute = new Date(Math.floor(bucket.getTime() / 60_000) * 60_000);
  const dueMove = bucket.getUTCSeconds() < 15;
  for (const observation of observations) {
    const minuteObservation = { ...observation, bucket: minute.toISOString() };
    if (dueMove) await store.saveObservation(minuteObservation);
    for (const rule of rules.filter((r) => r.asset === observation.asset)) {
      if (rule.detector === "fixed_price") {
        const id = await store.record({
          key: rule.id,
          ruleId: rule.id,
          revision: rule.updated_at,
          asset: rule.asset,
          mark: observation.mark_price,
          observedAt: observation.observed_at,
        }, "http_snapshot");
        if (id) occurrences++;
      } else if (dueMove) {
        const context = await store.moveContext(rule, minute);
        const result = evaluateLargeMove(rule, {
          current: minuteObservation,
          ...context,
        });
        await store.evaluation(
          rule,
          minute.toISOString(),
          result.status,
          result.evidence,
        );
        if (result.qualifies) {
          const id = await store.record(
            {
              key: rule.id,
              ruleId: rule.id,
              revision: rule.updated_at,
              asset: rule.asset,
              mark: observation.mark_price,
              observedAt: observation.observed_at,
            },
            "http_snapshot",
            result,
          );
          if (id) occurrences++;
        }
      }
    }
    if (dueMove) {
      const [previous] = await store
        .sql`select state from volatility_states where asset=${observation.asset}`;
      if (
        previous && Date.parse(previous.state.last_bucket) < minute.getTime()
      ) {
        const state = previous.state,
          age = minute.getTime() - Date.parse(state.last_bucket);
        if (age <= 120_000) {
          const residual = logReturn(observation.mark_price, state.last_mark);
          await store.saveVolatility({
            asset: observation.asset,
            fast_variance: updateVariance(state.fast_variance, residual, 30),
            slow_variance: updateVariance(state.slow_variance, residual, 360),
            last_mark: observation.mark_price,
            last_bucket: minute.toISOString(),
          });
        }
      }
    }
  }
  await store.heartbeat("fallback", {
    state: failures.length ? "partial" : "succeeded",
    assets_checked: observations.length,
    rules_checked: rules.length,
    occurrences_created: occurrences,
    failures,
  });
  return { occurrences, failures };
}
export async function calibrate(store: AlertStore) {
  if (!await store.active()) return;
  const rules = await store.activeRules();
  const seen = new Set<string>();
  for (
    const rule of rules.filter((r) => r.detector === "large_move").slice(0, 3)
  ) {
    const horizon = Number(rule.configuration.horizon_minutes),
      key = `${rule.asset}/${horizon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [existing] = await store
      .sql`select model from detector_models where asset=${rule.asset} and horizon_minutes=${horizon} and expires_at>now()+interval '1 hour'`;
    if (existing) continue;
    try {
      const history = await store
        .sql`select observation from market_observations where asset=${rule.asset} order by bucket desc limit 15000`;
      let model: ReturnType<typeof buildBootstrapModel> | undefined,
        source: "mark_history" | "trade_candle_bootstrap" = "mark_history";
      if (history.length >= horizon + 101) {
        try {
          model = buildBootstrapModel(
            history.reverse().map((r) => ({
              T: Date.parse(r.observation.bucket),
              c: r.observation.mark_price,
            })),
            horizon,
            1,
            "marks",
          );
        } catch { /* bootstrap below */ }
      }
      if (!model) {
        source = "trade_candle_bootstrap";
        const candles = await fetchCalibrationCandles(rule.asset, horizon);
        model = buildBootstrapModel(
          candles.candles,
          horizon,
          candles.intervalMinutes,
        );
      }
      await store.saveModel({
        asset: rule.asset,
        horizon_minutes: horizon,
        model_version: model.modelVersion,
        source,
        parameters: model.parameters,
        sample_count: model.sampleCount,
        expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      });
      const [state] = await store
        .sql`select 1 from volatility_states where asset=${rule.asset}`;
      const [latest] = await store
        .sql`select observation from market_observations where asset=${rule.asset} order by bucket desc limit 1`;
      if (!state && latest) {
        await store.saveVolatility({
          asset: rule.asset,
          fast_variance: model.parameters.fastVariance,
          slow_variance: model.parameters.slowVariance,
          last_mark: latest.observation.mark_price,
          last_bucket: latest.observation.bucket,
        });
      }
      log("calibration_ready", {
        asset: rule.asset,
        horizon,
        samples: model.sampleCount,
      });
    } catch {
      log("calibration_retry_pending", { asset: rule.asset, horizon });
    }
  }
}

async function stream(store: AlertStore, signal: AbortSignal) {
  const spool = Deno.env.get("PRICE_SPOOL_PATH") ??
    "/srv/hyperdata/spool/pending.json";
  let spoolFailed = false;
  const engine = new PriceAlertEngine(await readSpool(spool), async (rows) => {
    try {
      await saveSpool(spool, rows);
    } catch (e) {
      spoolFailed = true;
      throw e;
    }
  });
  let rules: StreamRule[] = [],
    active = false,
    refreshedAt: string | null = null,
    socket: WebSocket | null = null,
    reconnects = 0,
    openedAt = 0,
    lastFrame = 0,
    backoff = 500;
  const subscriptions = new Set<string>(), marks = new Map<string, number>();
  let refreshBusy = false,
    drainBusy = false,
    deliveryBusy = false,
    healthBusy = false,
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  async function refresh() {
    if (refreshBusy || signal.aborted) return;
    refreshBusy = true;
    try {
      active = await store.active();
      rules = active ? await store.activeRules() : [];
      engine.setRules(rules);
      refreshedAt = new Date().toISOString();
      sync();
    } catch {
      log("rule_refresh_failed");
    } finally {
      refreshBusy = false;
    }
  }
  function sync() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const wanted = new Set(["BTC", ...rules.map((rule) => rule.asset)]);
    for (const asset of subscriptions) {
      if (!wanted.has(asset)) {
        socket.send(
          JSON.stringify({
            method: "unsubscribe",
            subscription: { type: "activeAssetCtx", coin: asset },
          }),
        );
        subscriptions.delete(asset);
        marks.delete(asset);
      }
    }
    for (const asset of wanted) {
      if (!subscriptions.has(asset)) {
        socket.send(
          JSON.stringify({
            method: "subscribe",
            subscription: { type: "activeAssetCtx", coin: asset },
          }),
        );
        subscriptions.add(asset);
      }
    }
  }
  async function deliver() {
    if (deliveryBusy || !active || signal.aborted) return;
    deliveryBusy = true;
    try {
      for (const row of await drainDeliveries(store)) log("delivery", row);
    } catch {
      log("delivery_drain_failed");
    } finally {
      deliveryBusy = false;
    }
  }
  async function drain() {
    if (drainBusy || !active || signal.aborted) return;
    drainBusy = true;
    try {
      await engine.settled();
      await Promise.all([...engine.pending.values()].map(async (row) => {
        const id = await store.record(row);
        await engine.remove(row.key);
        if (id) {
          log("occurrence_recorded", {
            id,
            detectionToCommitMs: Date.now() - Date.parse(row.observedAt),
          });
          void refresh();
          void deliver();
        }
      }));
    } catch (error) {
      log("occurrence_retry_pending");
      if (spoolFailed) {
        log("spool_persistence_failed");
        Deno.exit(1);
      }
    } finally {
      drainBusy = false;
    }
  }
  function connect() {
    if (signal.aborted) return;
    const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
    socket = ws;
    const timeout = setTimeout(() => ws.close(), 10_000);
    ws.onopen = () => {
      clearTimeout(timeout);
      subscriptions.clear();
      marks.clear();
      openedAt = lastFrame = Date.now();
      sync();
      log("market_connected");
    };
    ws.onmessage = (e) => {
      if (signal.aborted || socket !== ws) return;
      lastFrame = Date.now();
      const tick = parseMarkFrame(String(e.data));
      if (!tick || !subscriptions.has(tick.asset)) return;
      marks.set(tick.asset, lastFrame);
      backoff = 500;
      if (active && engine.accept(tick.asset, tick.mark, lastFrame)) {
        void drain();
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      clearTimeout(timeout);
      subscriptions.clear();
      marks.clear();
      reconnects++;
      if (!signal.aborted) {
        reconnectTimer = setTimeout(connect, backoff + Math.random() * 250);
        backoff = Math.min(backoff * 2, 15_000);
      }
    };
  }
  async function health() {
    if (healthBusy) return;
    healthBusy = true;
    try {
      const stale = [...new Set(["BTC", ...rules.map((r) => r.asset)])].filter(
        (asset) => Date.now() - (marks.get(asset) ?? 0) > 10_000,
      );
      await store.heartbeat("stream", {
        connected: socket?.readyState === WebSocket.OPEN,
        last_market_at: marks.size
          ? new Date(Math.max(...marks.values())).toISOString()
          : null,
        rules_refreshed_at: refreshedAt,
        active_assets: new Set(rules.map((r) => r.asset)).size,
        pending_occurrences: engine.pending.size,
        oldest_pending_at: engine.pending.size
          ? new Date(
            Math.min(...[...engine.pending.values()].map((r) =>
              Date.parse(r.observedAt)
            )),
          ).toISOString()
          : null,
        reconnects,
        stale_assets: stale,
        active,
      });
      if (stale.length && Date.now() - openedAt > 15_000) socket?.close();
    } catch {
      log("heartbeat_failed");
    } finally {
      healthBusy = false;
    }
  }
  await refresh();
  connect();
  const unlisten = await store.sql.listen(
    "hyperdata_rules",
    () => void refresh(),
  );
  const timers = [
    setInterval(() => void refresh(), 1000),
    setInterval(() => void drain(), 250),
    setInterval(() => void deliver(), 1000),
    setInterval(() => void health(), 5000),
    setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        if (Date.now() - lastFrame > 15_000) socket.close();
        else socket.send('{"method":"ping"}');
      }
    }, 5000),
  ];
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );
  timers.forEach(clearInterval);
  clearTimeout(reconnectTimer);
  (socket as WebSocket | null)?.close();
  await unlisten.unlisten();
  await engine.settled();
  const deadline = Date.now() + 60_000;
  while (
    (deliveryBusy || drainBusy || healthBusy || refreshBusy) &&
    Date.now() < deadline
  ) await wait(50);
}
if (import.meta.main) {
  const store = new AlertStore(), abort = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(sig, () => abort.abort());
  }
  try {
    if (Deno.args[0] === "fallback") {
      let lastMinute = -1;
      while (!abort.signal.aborted) {
        const started = Date.now();
        try {
          await fallbackCycle(store, new Date());
          for (const row of await drainDeliveries(store)) log("delivery", row);
          const minute = Math.floor(Date.now() / 60_000);
          if (minute !== lastMinute) {
            lastMinute = minute;
            await calibrate(store);
            await store.prune();
          }
        } catch {
          log("fallback_cycle_failed");
        }
        await wait(Math.max(250, 15_000 - (Date.now() - started)));
      }
    } else await stream(store, abort.signal);
  } finally {
    await store.close();
  }
}
