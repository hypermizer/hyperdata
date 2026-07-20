import { APP_CONFIG } from "./config.js?v=20260718-listener";
import { displayRule, listenerHealth, normalizeAlertRuleInput } from "./lib/alert-rules.js?v=20260718-listener";
import {
  applyLiveMarketContext,
  buildPriceChangeSignals,
  fetchAverageDailyVolume,
  fetchPriceHistory,
} from "./lib/hyperliquid.js?v=20260720-assets";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260720-assets";
import { AssetPicker } from "./asset-picker.js?v=20260720-stream";
import { createWatchlistClient } from "./lib/supabase.js?v=20260718-listener";
import { deriveStreamHealth } from "./lib/stream-health.js?v=20260720-stream";

const state = {
  accountMessage: "",
  averageVolumes: new Map(),
  catalog: [],
  markets: new Map(),
  openDot: null,
  priceHistories: new Map(),
  supabase: createWatchlistClient(APP_CONFIG),
  stream: null,
  streamMessageAt: 0,
  streamOpenedAt: 0,
  streamPhase: "loading",
  streamStartedAt: 0,
  reconnectTimer: null,
  signingIn: false,
  user: null,
  watchlist: [...APP_CONFIG.initialWatchlist],
};

const elements = {
  accountButton: document.querySelector("#account-button"),
  accountStatus: document.querySelector("#account-status"),
  addAssetButton: document.querySelector("#add-asset-button"),
  alertAsset: document.querySelector("#alert-asset"),
  alertCount: document.querySelector("#alert-count"),
  alertForm: document.querySelector("#alert-form"),
  alertList: document.querySelector("#alert-list"),
  alertMessage: document.querySelector("#alert-message"),
  alertType: document.querySelector("#alert-type"),
  connectionLabel: document.querySelector("#connection-label"),
  lastSync: document.querySelector("#last-sync"),
  listenerHealth: document.querySelector("#listener-health"),
  marketList: document.querySelector("#market-list"),
  removeAsset: document.querySelector("#remove-asset"),
  removeAssetButton: document.querySelector("#remove-asset-button"),
  removeAssetForm: document.querySelector("#remove-asset-form"),
  settingsButton: document.querySelector("#settings-button"),
  settingsDialog: document.querySelector("#watchlist-settings"),
  tabs: [...document.querySelectorAll("[data-tab]")],
  views: [...document.querySelectorAll("[role=tabpanel]")],
  watchlistForm: document.querySelector("#watchlist-form"),
  watchlistMessage: document.querySelector("#watchlist-message"),
};
const watchlistAssetPicker = new AssetPicker(document.querySelector("#watchlist-asset-picker"));

wireEvents();
initialize();

async function initialize() {
  try {
    const markets = await getMarketCatalog();
    state.catalog = markets;
    updateMarketMap(markets);
    await initializeWatchlistStorage();
    ensureValidWatchlist();
    await Promise.all([refreshAverageVolumes(), refreshPriceHistories()]);
    renderCatalog();
    render();
    connectMarketStream();
  } catch (error) {
    state.streamPhase = "error";
    renderConnectionStatus(error.message);
    elements.marketList.textContent = "Market data unavailable.";
  }
}

function wireEvents() {
  elements.accountButton.addEventListener("click", handleAccountAction);
  elements.alertType.addEventListener("change", renderAlertFields);
  elements.settingsButton.addEventListener("click", openSettings);
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveView(tab.dataset.tab));
  });

  elements.watchlistForm.addEventListener("submit", addToWatchlist);
  elements.removeAssetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    removeFromWatchlist(elements.removeAsset.value);
  });
  elements.marketList.addEventListener("click", (event) => {
    const button = event.target.closest(".signal-dot-button");
    if (!button) return;
    const asset = button.dataset.asset;
    const label = button.dataset.label;
    const willOpen = state.openDot?.asset !== asset || state.openDot?.label !== label;
    closeDotTooltips();
    state.openDot = willOpen ? { asset, label } : null;
    button.classList.toggle("is-open", willOpen);
    button.setAttribute("aria-expanded", String(willOpen));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".signal-dot-button")) closeDotTooltips();
  });

  elements.alertForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.alertMessage.textContent = "";
    const submitButton = elements.alertForm.querySelector("button[type=submit]");
    submitButton.disabled = true;
    try {
      if (!state.user) throw new Error("Sign in first.");
      const form = new FormData(elements.alertForm);
      const detector = form.get("detector");
      const normalized = normalizeAlertRuleInput({ asset: form.get("asset"), detector, delivery: form.get("delivery"),
        direction: detector === "fixed_price" ? form.get("direction") : form.get("moveDirection"), target: form.get("target"),
        horizonMinutes: form.get("horizonMinutes"), tailPercentile: form.get("tailPercentile"), minimumMovePercent: form.get("minimumMovePercent") });
      const market = state.markets.get(normalized.asset);
      const { error } = await state.supabase.rpc("create_alert_rule", { p_asset: normalized.asset, p_dex: market?.dexId ?? "",
        p_detector: normalized.detector, p_configuration: normalized.configuration, p_delivery: normalized.delivery });
      if (error) throw error;
      elements.alertMessage.textContent = "Alert created.";
      await loadAlerts();
    } catch (error) {
      elements.alertMessage.textContent = error.message;
    } finally {
      submitButton.disabled = !state.user;
    }
  });

  elements.alertList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-rule-action]");
    if (!button || !state.user) return;
    button.disabled = true; elements.alertMessage.textContent = "";
    const action = button.dataset.ruleAction; const id = button.dataset.ruleId;
    const request = action === "delete" ? state.supabase.rpc("delete_alert_rule", { p_rule_id: id })
      : state.supabase.rpc("set_alert_rule_enabled", { p_rule_id: id, p_enabled: action === "enable" });
    const { error } = await request;
    if (error) elements.alertMessage.textContent = error.message;
    await loadAlerts();
  });

  setInterval(refreshAverageVolumes, APP_CONFIG.averageVolumeRefreshIntervalMs);
  setInterval(refreshPriceHistories, APP_CONFIG.priceHistoryRefreshIntervalMs);
  setInterval(loadAlerts, APP_CONFIG.alertsRefreshIntervalMs);
  setInterval(checkQuoteHealth, 1_000);
  setInterval(sendStreamHeartbeat, 30_000);
}

async function initializeWatchlistStorage() {
  if (!state.supabase) {
    renderAccount();
    return;
  }
  const { data: { session }, error } = await state.supabase.auth.getSession();
  if (error) throw error;
  await setSession(session);
  state.supabase.auth.onAuthStateChange((_event, nextSession) => {
    window.setTimeout(() => {
      setSession(nextSession).catch((error) => setAccountMessage(error.message));
    }, 0);
  });
}

async function setSession(session) {
  state.user = session?.user ?? null;
  if (state.user && state.user.email !== APP_CONFIG.allowedEmail) {
    await state.supabase.auth.signOut();
    state.user = null;
    setAccountMessage("This is a personal app.");
  }
  if (state.user) {
    state.accountMessage = "";
    await Promise.all([loadCloudWatchlist(), loadAlerts()]);
  } else {
    state.watchlist = [...APP_CONFIG.initialWatchlist];
    await loadAlerts();
  }
  ensureValidWatchlist();
  renderAccount();
  render();
}

async function handleAccountAction() {
  if (!state.supabase) {
    setAccountMessage("Storage unavailable.");
    return;
  }
  if (state.user) {
    const { error } = await state.supabase.auth.signOut();
    state.accountMessage = error ? error.message : "";
    renderAccount();
    return;
  }
  state.signingIn = true;
  renderAccount();
  setAccountMessage("Sending link…");
  try {
    const { error } = await state.supabase.auth.signInWithOtp({
      email: APP_CONFIG.allowedEmail,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    setAccountMessage(error ? formatAuthError(error) : "Link sent. Open it in this browser.");
  } catch (error) {
    setAccountMessage(error instanceof Error ? formatAuthError(error) : "Unable to send sign-in link.");
  } finally {
    state.signingIn = false;
    renderAccount();
  }
}

async function loadCloudWatchlist() {
  const { data, error } = await state.supabase
    .from("watchlist_items")
    .select("asset")
    .order("created_at");
  if (error) throw error;
  if (data.length) {
    state.watchlist = data.map((item) => item.asset);
    return;
  }
  const { data: seeded, error: seedError } = await state.supabase
    .from("watchlist_items")
    .upsert(
      APP_CONFIG.initialWatchlist.map((asset) => ({ user_id: state.user.id, asset })),
      { onConflict: "user_id,asset" },
    )
    .select("asset");
  if (seedError) throw seedError;
  state.watchlist = seeded.map((item) => item.asset);
}

function renderAccount() {
  const storageReady = Boolean(state.supabase);
  elements.accountButton.disabled = !storageReady || state.signingIn;
  watchlistAssetPicker.setDisabled(!state.user);
  elements.addAssetButton.disabled = !state.user;
  elements.removeAsset.disabled = !state.user || state.watchlist.length <= 1;
  elements.removeAssetButton.disabled = !state.user || state.watchlist.length <= 1;
  elements.accountButton.textContent = state.user ? "Sign out" : "Sign in";
  const status = state.user
    ? state.user.email
    : state.signingIn
      ? "Sending link…"
      : storageReady
        ? "Not signed in"
        : "Storage unavailable";
  elements.accountStatus.textContent = state.accountMessage || status;
}

async function addToWatchlist(event) {
  event.preventDefault();
  if (!state.user) return;
  const market = state.markets.get(watchlistAssetPicker.value);
  if (!market) {
    setWatchlistMessage("Choose an asset from the list.");
    return;
  }
  const { error } = await state.supabase.from("watchlist_items").insert({
    user_id: state.user.id,
    asset: market.id,
  });
  if (error && error.code !== "23505") {
    setWatchlistMessage(error.message);
    return;
  }
  watchlistAssetPicker.clear();
  await loadCloudWatchlist();
  ensureValidWatchlist();
  await Promise.all([refreshAverageVolumes(), refreshPriceHistories()]);
  render();
  connectMarketStream();
}

async function removeFromWatchlist(asset) {
  if (!state.user) return;
  if (state.watchlist.length === 1) return;
  const { error } = await state.supabase
    .from("watchlist_items")
    .delete()
    .eq("user_id", state.user.id)
    .eq("asset", asset);
  if (error) {
    setWatchlistMessage(error.message);
    return;
  }
  await loadCloudWatchlist();
  state.priceHistories.delete(asset);
  ensureValidWatchlist();
  render();
  connectMarketStream();
}

async function refreshAverageVolumes(assetIds = state.watchlist) {
  const results = await Promise.allSettled(
    [...new Set(assetIds)].map(async (asset) => [
      asset,
      await fetchAverageDailyVolume(asset),
    ]),
  );
  results.forEach((result) => {
    if (result.status === "fulfilled") {
      const [asset, volume] = result.value;
      state.averageVolumes.set(asset, volume);
    }
  });
  renderMarkets();
}

async function refreshPriceHistories(assetIds = state.watchlist) {
  const results = await Promise.allSettled(
    [...new Set(assetIds)].map(async (asset) => [
      asset,
      await fetchPriceHistory(asset),
    ]),
  );
  results.forEach((result) => {
    if (result.status === "fulfilled") {
      const [asset, points] = result.value;
      state.priceHistories.set(asset, points);
    }
  });
  renderMarkets();
}

function updateMarketMap(markets) {
  markets.forEach((market) => state.markets.set(market.id, market));
  updateLastSync();
}

function updateLastSync() {
  elements.lastSync.textContent = new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function ensureValidWatchlist() {
  state.watchlist = state.watchlist.filter((id) => state.markets.has(id));
  if (!state.watchlist.length) throw new Error("No configured watchlist assets are available.");
}

function render() {
  renderMarkets();
  renderAlertOptions();
  renderWatchlistSettings();
  renderAccount();
  renderAlertFields();
}

function renderCatalog() {
  watchlistAssetPicker.setCatalog(state.catalog);
}

function renderMarkets() {
  const rows = state.watchlist
    .map((id) => state.markets.get(id))
    .filter(Boolean)
    .map((market) => {
      const direction = market.changePercent >= 0 ? "positive" : "negative";
      return `<tr><td class="asset-cell">${escapeHtml(displayAssetName(market.id))}</td><td class="signal-cell">${renderPriceSignals(market)}</td><td class="metric">${formatPrice(market.markPrice)}</td><td class="metric ${direction}">${formatPercent(market.changePercent)}</td><td class="metric">${formatUsdCompact(market.volume24h)}</td><td class="metric">${formatUsdCompact(state.averageVolumes.get(market.id))}</td><td class="metric">${formatCompact(market.openInterest)}</td></tr>`;
    })
    .join("");
  elements.marketList.innerHTML = `<table class="market-table"><thead><tr><th class="asset-cell">ASSET</th><th class="signal-cell" title="1w, 1d, 6h, 1h, 30m, 10m, 5m">${renderSignalLabels()}</th><th>MARK</th><th>24H +/-</th><th>24H VOL</th><th>AVG VOL</th><th>OI</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPriceSignals(market) {
  const signals = buildPriceChangeSignals(
    market.markPrice,
    state.priceHistories.get(market.id) ?? [],
  );
  const dots = signals
    .map((signal) => {
      const detail = formatDotDetail(signal);
      const isOpen = state.openDot?.asset === market.id && state.openDot?.label === signal.label;
      return `<span class="signal-slot"><button class="signal-dot-button${isOpen ? " is-open" : ""}" type="button" data-asset="${escapeHtml(market.id)}" data-label="${escapeHtml(signal.label)}" aria-label="${escapeHtml(detail)}" aria-expanded="${isOpen}"><span class="change-dot ${signal.direction} ${signal.intensity}"></span><span class="dot-tooltip" role="tooltip">${escapeHtml(detail)}</span></button></span>`;
    })
    .join("");
  return `<span class="signal-grid price-dots">${dots}</span>`;
}

function renderSignalLabels() {
  return `<span class="signal-grid signal-labels">${["1W", "1D", "6H", "1H", "30M", "10M", "5M"]
    .map((label) => `<span class="signal-slot">${label}</span>`)
    .join("")}</span>`;
}

function renderAlertOptions() {
  const selected = elements.alertAsset.value;
  elements.alertAsset.innerHTML = `<option value="">Choose asset</option>${state.watchlist
    .map((id) => {
      const market = state.markets.get(id);
      return `<option value="${escapeHtml(id)}">${escapeHtml(displayAssetName(market.id))} (${formatPrice(market.markPrice)})</option>`;
    })
    .join("")}`;
  if (state.watchlist.includes(selected)) elements.alertAsset.value = selected;
}

function renderWatchlistSettings() {
  const selected = elements.removeAsset.value;
  elements.removeAsset.innerHTML = state.watchlist
    .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(displayAssetName(id))}</option>`)
    .join("");
  if (state.watchlist.includes(selected)) elements.removeAsset.value = selected;
}

function openSettings() {
  if (typeof elements.settingsDialog.showModal === "function") {
    elements.settingsDialog.showModal();
  } else {
    elements.settingsDialog.setAttribute("open", "");
  }
}

function closeDotTooltips() {
  state.openDot = null;
  elements.marketList.querySelectorAll(".signal-dot-button.is-open").forEach((button) => {
    button.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  });
}

async function loadAlerts() {
  if (!state.user || !state.supabase) {
    elements.alertCount.textContent = "—"; elements.listenerHealth.textContent = "SIGN IN TO LOAD";
    elements.alertList.innerHTML = `<p class="hint">Sign in to manage alerts.</p>`; return;
  }
  try {
    const [rulesResponse, runsResponse, statesResponse, occurrencesResponse, deliveryResponse] = await Promise.all([
      state.supabase.from("alert_rules").select("*").is("deleted_at", null).order("created_at", { ascending: false }),
      state.supabase.from("monitor_runs").select("*").order("bucket", { ascending: false }).limit(1),
      state.supabase.from("rule_evaluation_state").select("rule_id,status,tail_percentile,updated_at"),
      state.supabase.from("alert_occurrences").select("id,rule_id,bucket").order("bucket", { ascending: false }).limit(100),
      state.supabase.from("notification_outbox").select("occurrence_id,state,updated_at").order("updated_at", { ascending: false }).limit(100),
    ]);
    const error = rulesResponse.error ?? runsResponse.error ?? statesResponse.error ?? occurrencesResponse.error ?? deliveryResponse.error; if (error) throw error;
    const rules = rulesResponse.data ?? []; const states = new Map((statesResponse.data ?? []).map((item) => [item.rule_id, item]));
    const deliveryByOccurrence = new Map((deliveryResponse.data ?? []).map((item) => [item.occurrence_id, item.state]));
    const latestDeliveryByRule = new Map();
    (occurrencesResponse.data ?? []).forEach((occurrence) => {
      if (!latestDeliveryByRule.has(occurrence.rule_id) && deliveryByOccurrence.has(occurrence.id)) latestDeliveryByRule.set(occurrence.rule_id, deliveryByOccurrence.get(occurrence.id));
    });
    elements.listenerHealth.textContent = listenerHealth(runsResponse.data?.[0]); elements.alertCount.textContent = String(rules.filter((rule) => rule.enabled).length);
    elements.alertList.innerHTML = rules.length ? rules.map((rule) => {
      const evaluation = states.get(rule.id); const status = evaluation?.status ?? (rule.detector === "large_move" ? "warming" : "not evaluated");
      const deliveryState = latestDeliveryByRule.get(rule.id);
      const meta = `${rule.enabled ? status : "disabled"}${deliveryState ? ` · delivery ${deliveryState}` : ""}`;
      return `<div class="alert-card"><span><span>${escapeHtml(displayRule(rule))} · ${rule.delivery === "sms" ? "text" : "email"}</span><br><span class="alert-meta">${escapeHtml(meta)}</span></span><span class="alert-card-actions"><button type="button" data-rule-action="${rule.enabled ? "disable" : "enable"}" data-rule-id="${escapeHtml(rule.id)}">${rule.enabled ? "off" : "on"}</button><button type="button" data-rule-action="delete" data-rule-id="${escapeHtml(rule.id)}">×</button></span></div>`;
    }).join("") : `<p class="hint">No alerts.</p>`;
  } catch (error) {
    elements.alertCount.textContent = "—";
    elements.listenerHealth.textContent = "MONITOR UNKNOWN";
    elements.alertList.innerHTML = `<p class="hint">${escapeHtml(error.message ?? "Could not load alerts.")}</p>`;
  }
}

function renderAlertFields() {
  const isMove = elements.alertType.value === "large_move";
  document.querySelectorAll("[data-fixed-field]").forEach((field) => { field.hidden = isMove; field.disabled = isMove || !state.user; });
  document.querySelectorAll("[data-move-field]").forEach((field) => { field.hidden = !isMove; field.disabled = !isMove || !state.user; });
  elements.alertType.disabled = !state.user; elements.alertAsset.disabled = !state.user;
  document.querySelector("#alert-delivery").disabled = !state.user;
  elements.alertForm.querySelector("button[type=submit]").disabled = !state.user;
}

function setActiveView(viewName) {
  elements.tabs.forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === viewName));
  });
  elements.views.forEach((view) => {
    view.hidden = view.id !== `${viewName}-view`;
  });
}

function renderConnectionStatus(detail = "") {
  const health = deriveStreamHealth({
    phase: state.streamPhase,
    startedAt: state.streamStartedAt,
    openedAt: state.streamOpenedAt,
    lastMessageAt: state.streamMessageAt,
    detail,
  });
  if (elements.connectionLabel.textContent !== health.label) {
    elements.connectionLabel.textContent = health.label;
  }
  if (elements.connectionLabel.className !== health.tone) {
    elements.connectionLabel.className = health.tone;
  }
  return health;
}

function setWatchlistMessage(message) {
  elements.watchlistMessage.textContent = message;
}

function setAccountMessage(message) {
  state.accountMessage = message;
  renderAccount();
}

function formatAuthError(error) {
  const message = error?.message ?? String(error);
  return /rate limit/i.test(message)
    ? "Email limit reached. Try again in about an hour."
    : message;
}

function connectMarketStream() {
  window.clearTimeout(state.reconnectTimer);
  state.stream?.close();
  state.streamPhase = "connecting";
  state.streamStartedAt = Date.now();
  state.streamOpenedAt = 0;
  state.streamMessageAt = 0;
  renderConnectionStatus();
  const stream = new WebSocket(APP_CONFIG.websocketUrl);
  state.stream = stream;

  stream.addEventListener("open", () => {
    if (state.stream !== stream) return;
    state.streamPhase = "open";
    state.streamOpenedAt = Date.now();
    state.watchlist.forEach((coin) => {
      stream.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "activeAssetCtx", coin },
      }));
    });
    renderConnectionStatus();
  });

  stream.addEventListener("message", ({ data }) => {
    if (state.stream !== stream) return;
    state.streamMessageAt = Date.now();
    renderConnectionStatus();
    const message = JSON.parse(data);
    if (message.channel !== "activeAssetCtx") return;
    const market = state.markets.get(message.data.coin);
    if (!market) return;
    state.markets.set(message.data.coin, applyLiveMarketContext(market, message.data.ctx));
    updateLastSync();
    renderMarkets();
    renderAlertOptions();
  });

  stream.addEventListener("close", () => {
    if (state.stream !== stream) return;
    state.streamPhase = "closed";
    renderConnectionStatus();
    state.reconnectTimer = window.setTimeout(connectMarketStream, 3_000);
  });

  stream.addEventListener("error", () => stream.close());
}

function checkQuoteHealth() {
  const health = renderConnectionStatus();
  if (health.shouldReconnect) connectMarketStream();
}

function sendStreamHeartbeat() {
  if (state.stream?.readyState !== WebSocket.OPEN) return;
  state.stream.send(JSON.stringify({ method: "ping" }));
}

function formatDotDetail({ label, referencePrice, changePercent }) {
  if (referencePrice === null || changePercent === null) {
    return `${label.toUpperCase()} reference unavailable`;
  }
  return `${label.toUpperCase()} reference ${formatPrice(referencePrice)} · ${formatPercent(changePercent)}`;
}

function displayAssetName(asset) {
  return asset.startsWith("xyz:") ? asset.slice(4) : asset;
}

function formatPrice(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1 ? 2 : 6,
  }).format(value);
}

function formatPercent(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatUsdCompact(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCompact(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
