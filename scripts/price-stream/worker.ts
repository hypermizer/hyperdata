import { createClient } from "@supabase/supabase-js";
import { PriceAlertEngine, parseMarkFrame, type StreamRule } from "./engine.ts";
import { readSpool, saveSpool } from "./spool.ts";
import { deliverClaims } from "../../supabase/functions/deliver-alerts/service.ts";
import type { ClaimedOutbox } from "../../supabase/functions/deliver-alerts/dispatcher.ts";

const required = (name: string) => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const url = required("SUPABASE_URL"), key = required("SUPABASE_SERVICE_ROLE_KEY");
const secret = required("MONITOR_SECRET"), workerId = required("PRICE_WORKER_ID");
const spoolPath = required("PRICE_SPOOL_PATH");
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) }) } });
const engine = new PriceAlertEngine(await readSpool(spoolPath), (rows) => saveSpool(spoolPath, rows));
let socket: WebSocket | null = null, stopped = false, reconnects = 0, backoff = 500;
let unhealthySince: string | null = null;
let rulesRefreshedAt: string | null = null, lastFrameAt = 0, openedAt = 0;
let refreshBusy = false, refreshAgain = false, drainBusy = false, deliveryBusy = false, healthBusy = false;
const subscriptions = new Set<string>(), marksAt = new Map<string, number>();
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const log = (event: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
const fatal = (event: string) => { log(event); Deno.exit(1); };

function syncSubscriptions() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  // A sentinel verifies the market feed even when no alert is armed.
  const wanted = new Set(["BTC", ...engine.rules.map((rule) => rule.asset)]);
  for (const asset of subscriptions) if (!wanted.has(asset)) {
    socket.send(JSON.stringify({ method: "unsubscribe", subscription: { type: "activeAssetCtx", coin: asset } }));
    subscriptions.delete(asset); marksAt.delete(asset);
  }
  for (const asset of wanted) if (!subscriptions.has(asset)) {
    socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: asset } }));
    subscriptions.add(asset);
  }
}
async function refreshRules() {
  if (stopped) return;
  if (refreshBusy) { refreshAgain = true; return; }
  refreshBusy = true;
  try {
    const { data, error } = await client.from("alert_rules").select("*").eq("enabled", true).is("deleted_at", null).eq("detector", "fixed_price");
    if (error) throw error;
    engine.setRules((data ?? []) as StreamRule[]);
    rulesRefreshedAt = new Date().toISOString(); syncSubscriptions();
  } catch { log("rule_refresh_failed"); }
  finally {
    refreshBusy = false;
    if (refreshAgain) { refreshAgain = false; void refreshRules(); }
  }
}
function connect() {
  if (stopped) return;
  socket = new WebSocket("wss://api.hyperliquid.xyz/ws");
  const current = socket;
  const handshake = setTimeout(() => { if (current.readyState !== WebSocket.OPEN) current.close(); }, 10_000);
  current.onopen = () => {
    clearTimeout(handshake); openedAt = lastFrameAt = Date.now(); subscriptions.clear(); marksAt.clear();
    syncSubscriptions(); log("market_connected");
  };
  current.onmessage = (event) => {
    if (stopped || current !== socket) return;
    lastFrameAt = Date.now();
    const tick = parseMarkFrame(String(event.data));
    if (!tick || !subscriptions.has(tick.asset)) return;
    backoff = 500; marksAt.set(tick.asset, lastFrameAt);
    if (engine.accept(tick.asset, tick.mark, lastFrameAt)) void drain();
  };
  current.onerror = () => current.close();
  current.onclose = () => {
    clearTimeout(handshake); if (current !== socket) return;
    subscriptions.clear(); marksAt.clear(); reconnects += 1;
    log("market_disconnected", { reconnects });
    if (!stopped) { reconnectTimer = setTimeout(connect, backoff + Math.random() * 250); backoff = Math.min(15_000, backoff * 2); }
  };
}
async function deliver() {
  if (stopped) return;
  if (Deno.env.get("DELIVERY_ENABLED") !== "true") return;
  if (deliveryBusy) return;
  deliveryBusy = true;
  try {
    // Claim phone deliveries before waking the shared Edge drain. Send in parallel
    // with email, from this server's dedicated egress rather than Supabase's pool.
    const { data: claims, error: claimError } = await client.rpc("claim_outbox", { p_limit: 10, p_channel: "ntfy" });
    if (claimError) throw claimError;
    const phone = deliverClaims(client, (claims ?? []) as ClaimedOutbox[]).then((rows) => {
      for (const row of rows) log("delivery", { id: row.id, state: row.state });
    });
    await Promise.all([phone, deliverViaEdge()]);
  } catch { log("delivery_drain_failed"); }
  finally { deliveryBusy = false; }
}
async function deliverViaEdge() {
  try {
    const { data: due, error } = await client.from("notification_outbox").select("id").in("state", ["queued", "retry_wait"])
      .lte("next_attempt_at", new Date().toISOString()).limit(1);
    if (error) throw error;
    if (!due?.length) return;
    const response = await fetch(`${url}/functions/v1/deliver-alerts`, { method: "POST", signal: AbortSignal.timeout(45_000),
      headers: { authorization: `Bearer ${key}`, "x-monitor-secret": secret, "content-type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error("Delivery endpoint failed");
    const result = await response.json();
    if (result.status === "delivery_disabled") log("delivery_disabled");
    for (const row of result.outcomes ?? []) log("delivery", { id: row.id, state: row.state });
  } catch { log("delivery_drain_failed"); }
}
async function drain() {
  if (stopped) return;
  if (drainBusy) return;
  drainBusy = true;
  try {
    try { await engine.settled(); } catch { fatal("spool_write_failed"); }
    await Promise.all([...engine.pending.values()].map(async (candidate) => {
      const { data, error } = await client.rpc("record_alert_occurrence", {
        p_rule_id: candidate.ruleId, p_bucket: candidate.observedAt, p_mark_price: candidate.mark,
        p_classification: "fixed_price", p_evidence: { source: "websocket", observedAt: candidate.observedAt, ruleUpdatedAt: candidate.revision },
      });
      if (error) { log("occurrence_retry_pending", { ruleId: candidate.ruleId }); return; }
      try { await engine.remove(candidate.key); } catch { fatal("spool_write_failed"); }
      if (data) { log("occurrence_recorded", { id: data, detectionToCommitMs: Date.now() - Date.parse(candidate.observedAt) }); void deliver(); }
    }));
  } catch { log("occurrence_drain_failed"); }
  finally { drainBusy = false; }
}
async function health() {
  if (healthBusy) return;
  healthBusy = true;
  try {
    const stale = [...new Set(["BTC", ...engine.rules.map((rule) => rule.asset)])]
      .filter((asset) => Date.now() - (marksAt.get(asset) ?? 0) > 10_000);
    const healthy = !stale.length && socket?.readyState === WebSocket.OPEN
      && rulesRefreshedAt !== null && Date.now() - Date.parse(rulesRefreshedAt) < 20_000;
    unhealthySince = healthy ? null : unhealthySince ?? new Date().toISOString();
    const pendingTimes = [...engine.pending.values()].map((row) => Date.parse(row.observedAt));
    const { error } = await client.from("price_stream_health").upsert({ worker_id: workerId, heartbeat_at: new Date().toISOString(),
      connected: socket?.readyState === WebSocket.OPEN, last_market_at: marksAt.size ? new Date(Math.max(...marksAt.values())).toISOString() : null,
      rules_refreshed_at: rulesRefreshedAt, active_assets: new Set(engine.rules.map((rule) => rule.asset)).size,
      pending_occurrences: engine.pending.size, reconnects, stale_assets: stale, unhealthy_since: unhealthySince,
      oldest_pending_at: pendingTimes.length ? new Date(Math.min(...pendingTimes)).toISOString() : null });
    if (error) log("heartbeat_failed");
    if (stale.length && Date.now() - openedAt > 15_000 && socket?.readyState === WebSocket.OPEN) socket.close();
  } catch { log("heartbeat_failed"); }
  finally { healthBusy = false; }
}

await refreshRules(); connect();
client.channel("price-alert-rule-updates").on("postgres_changes", { event: "*", schema: "public", table: "alert_rules" }, () => void refreshRules())
  .subscribe((status) => { if (status === "SUBSCRIBED") { log("rule_changes_connected"); void refreshRules(); } });
const timers = [
  setInterval(() => void refreshRules(), 5_000), setInterval(() => void drain(), 1_000),
  setInterval(() => void deliver(), 5_000), setInterval(() => void health(), 5_000),
  setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastFrameAt > 15_000) socket.close();
    else socket.send(JSON.stringify({ method: "ping" }));
  }, 5_000),
];
for (const signal of ["SIGTERM", "SIGINT"] as const) Deno.addSignalListener(signal, () => {
  if (stopped) return; stopped = true;
  timers.forEach(clearInterval); clearTimeout(reconnectTimer); socket?.close();
  void client.removeAllChannels();
  void (async () => {
    await engine.settled();
    const deadline = Date.now() + 60_000;
    while ((drainBusy || deliveryBusy || refreshBusy || healthBusy) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    Deno.exit(0);
  })().catch(() => Deno.exit(1));
});
log("worker_started", { workerId, recoveredOccurrences: engine.pending.size });
await drain(); await health();
