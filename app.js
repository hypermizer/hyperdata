import { APP_CONFIG } from "./config.js?v=20260718-listener";
import { createAssetChart } from "./asset-chart.js?v=20260801-bars-news";
import { requestSignInLink } from "./lib/auth.js?v=20260727-login";
import { alertStatusLabel, displayRule, listenerHealth, normalizeAlertRuleInput } from "./lib/alert-rules.js?v=20260801-alerts";
import { annualizedFundingApr, calculateHourlyRsi, filterAndSortTradFiAssets, hydrateTradFiMarkets, nextColumnSort } from "./lib/assets.js?v=20260801-rsi";
import { applyAssetAnalyticsRows } from "./lib/asset-analytics.js?v=20260801-cache";
import {
  applyLiveMarketContext,
  buildPriceChangeSignals,
  CANDLE_INTERVALS,
  fetchCandles,
  MAX_CANDLE_BARS,
  mergeLiveCandle,
  normalizeCandle,
} from "./lib/hyperliquid.js?v=20260801-bars-news";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260720-assets";
import { fetchAssetFundamentals } from "./lib/fundamentals.js?v=20260801";
import { fetchAssetNews } from "./lib/news.js?v=20260801-ranked";
import { createWatchlistClient } from "./lib/supabase.js?v=20260728-persistent-auth";
import { hasAuthCallbackParameters } from "./lib/session.js?v=20260728-persistent-auth";
import { deriveStreamHealth } from "./lib/stream-health.js?v=20260720-stream";
import { parseRoute, routeFor } from "./lib/routes.js?v=20260801-bars-news";

const UTC_MINUTE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const state = {
  accountMessage: "",
  assetCandles: [],
  assetChart: null,
  assetChartAsset: null,
  assetChartInterval: null,
  assetChartCursorTime: null,
  assetChartLoadToken: 0,
  assetChartRetryTimer: null,
  assetCandleSubscription: null,
  assetFundamentals: new Map(),
  assetFundamentalsErrors: new Map(),
  assetFundamentalsPending: new Set(),
  assetNewsAsset: null,
  assetNewsLoadToken: 0,
  averageVolumes: new Map(),
  catalog: [],
  favoritePending: new Set(),
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
  marketRenderTimer: null,
  marketRenderedAt: 0,
  query: "",
  signingIn: false,
  sort: "asset-asc",
  user: null,
  watchedFirst: false,
  watchlist: [...APP_CONFIG.initialWatchlist],
};

const elements = {
  accountButton: document.querySelector("#account-button"),
  accountStatus: document.querySelector("#account-status"),
  assetChart: document.querySelector("#asset-chart"),
  assetChartStatus: document.querySelector("#asset-chart-status"),
  assetBarReadout: document.querySelector("#asset-bar-readout"),
  assetCount: document.querySelector("#asset-count"),
  assetDetailMetrics: document.querySelector("#asset-detail-metrics"),
  assetDetailName: document.querySelector("#asset-detail-name"),
  assetDetailOfficialName: document.querySelector("#asset-detail-official-name"),
  assetDetailSignals: document.querySelector("#asset-detail-signals"),
  assetCompanyProfile: document.querySelector("#asset-company-profile"),
  assetFilter: document.querySelector("#asset-filter"),
  assetHyperliquidLink: document.querySelector("#asset-hyperliquid-link"),
  assetIntervals: document.querySelector("#asset-intervals"),
  assetTabs: document.querySelector("#asset-tabs"),
  assetPanels: [...document.querySelectorAll("[data-asset-panel]")],
  assetFinancialsContent: document.querySelector("#asset-financials-content"),
  assetFinancialsStatus: document.querySelector("#asset-financials-status"),
  assetNewsList: document.querySelector("#asset-news-list"),
  assetNewsStatus: document.querySelector("#asset-news-status"),
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
  settingsButton: document.querySelector("#settings-button"),
  settingsDialog: document.querySelector("#watchlist-settings"),
  tabs: [...document.querySelectorAll("[data-tab]")],
  views: [...document.querySelectorAll("main > section[role=tabpanel]")],
  paperTabs: [...document.querySelectorAll("[data-paper-tab]")],
  paperPanels: [...document.querySelectorAll("[data-paper-panel]")],
  toolsTabs: [...document.querySelectorAll("[data-tools-tab]")],
  toolsPanels: [...document.querySelectorAll("[data-tools-panel]")],
  watchlistMessage: document.querySelector("#watchlist-message"),
  watchedFirst: document.querySelector("#watched-first"),
};

wireEvents();
initialize();

async function initialize() {
  try {
    await initializeWatchlistStorage();
  } catch (error) {
    setAccountMessage(error instanceof Error ? formatAuthError(error) : "Unable to restore browser session.");
  }
  renderRoute();
  try {
    const [markets] = await Promise.all([getMarketCatalog(), loadCachedAssetAnalytics()]);
    state.catalog = markets;
    updateMarketMap(markets);
    if (!tradFiMarkets().length) throw new Error("No XYZ TradFi markets were returned.");
    ensureValidWatchlist();
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
  elements.assetFilter.addEventListener("input", () => {
    state.query = elements.assetFilter.value;
    renderMarkets();
  });
  elements.watchedFirst.addEventListener("change", () => {
    state.watchedFirst = elements.watchedFirst.checked;
    renderMarkets();
  });
  window.addEventListener("hashchange", renderRoute);
  if (!hasAuthCallbackParameters()) renderRoute();

  elements.marketList.addEventListener("click", async (event) => {
    const sortButton = event.target.closest("[data-sort-column]");
    if (sortButton) {
      state.sort = nextColumnSort(state.sort, sortButton.dataset.sortColumn);
      renderMarkets();
      return;
    }
    const favoriteButton = event.target.closest("[data-watch-asset]");
    if (favoriteButton) {
      await toggleWatchedAsset(favoriteButton.dataset.watchAsset);
      return;
    }
    handleSignalClick(event);
  });
  elements.assetDetailSignals.addEventListener("click", handleSignalClick);
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

  setInterval(loadCachedAssetAnalytics, APP_CONFIG.assetAnalyticsCachePollIntervalMs);
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
    state.watchlist = [...APP_CONFIG.initialWatchlist].filter((id) => state.markets.size === 0 || state.markets.has(id));
    await loadAlerts();
  }
  if (state.markets.size) {
    ensureValidWatchlist();
    render();
    if (state.stream) connectMarketStream();
  } else {
    renderAccount();
  }
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
    await requestSignInLink(state.supabase);
    setAccountMessage("Link sent. Open it in this browser.");
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
  state.watchlist = data.map((item) => item.asset);
  dispatchWatchlist();
}

function dispatchWatchlist() {
  window.dispatchEvent(new CustomEvent("hyperdata:watchlist", { detail: { assets: [...state.watchlist] } }));
}

function renderAccount() {
  const storageReady = Boolean(state.supabase);
  elements.accountButton.disabled = !storageReady || state.signingIn;
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

async function toggleWatchedAsset(asset) {
  if (state.favoritePending.has(asset)) return;
  if (!state.user) {
    setWatchlistMessage("Sign in to save watched assets.");
    return;
  }
  const wasWatched = state.watchlist.includes(asset);
  state.favoritePending.add(asset);
  state.watchlist = wasWatched
    ? state.watchlist.filter((id) => id !== asset)
    : [...state.watchlist, asset];
  renderMarkets();
  renderAlertOptions();
  try {
    const request = wasWatched
      ? state.supabase.from("watchlist_items").delete().eq("user_id", state.user.id).eq("asset", asset)
      : state.supabase.from("watchlist_items").upsert({ user_id: state.user.id, asset }, { onConflict: "user_id,asset" });
    const { error } = await request;
    if (error) throw error;
    dispatchWatchlist();
    setWatchlistMessage(`${displayAssetName(asset)} ${wasWatched ? "removed from" : "added to"} watched assets.`);
  } catch (error) {
    state.watchlist = wasWatched
      ? [...state.watchlist, asset]
      : state.watchlist.filter((id) => id !== asset);
    renderMarkets();
    renderAlertOptions();
    setWatchlistMessage(error.message);
  } finally {
    state.favoritePending.delete(asset);
    renderMarkets();
  }
}

async function loadCachedAssetAnalytics() {
  if (!state.supabase) return 0;
  const { data, error } = await state.supabase
    .from("asset_analytics_cache")
    .select("asset,average_daily_volume,price_history");
  if (error) return 0;
  const applied = applyAssetAnalyticsRows(data, state);
  if (applied && state.catalog.length) scheduleMarketRender();
  return applied;
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
}

function render() {
  renderMarkets();
  renderAlertOptions();
  renderAccount();
  renderAlertFields();
  renderRoute();
}

function renderMarkets() {
  const now = Date.now();
  const markets = tradFiMarkets();
  const totalAssets = markets.length;
  const rsiValues = new Map(markets.map((market) => [
    market.id,
    calculateHourlyRsi(state.priceHistories.get(market.id) ?? [], market.markPrice, now),
  ]));
  const visibleMarkets = filterAndSortTradFiAssets(markets, {
    averageVolumes: state.averageVolumes,
    now,
    priceHistories: state.priceHistories,
    query: state.query,
    rsiValues,
    sort: state.sort,
    watched: state.watchlist,
    watchedFirst: state.watchedFirst,
  });
  const watched = new Set(state.watchlist);
  elements.assetCount.textContent = state.query.trim()
    ? `${visibleMarkets.length} / ${totalAssets} ASSETS`
    : `${totalAssets} ASSETS`;
  const rows = visibleMarkets
    .map((market) => {
      const direction = market.changePercent >= 0 ? "positive" : "negative";
      const isWatched = watched.has(market.id);
      const favoritePending = state.favoritePending.has(market.id);
      const rsi = rsiValues.get(market.id);
      const watchLabel = `${isWatched ? "Remove" : "Add"} ${displayAssetName(market.id)} ${isWatched ? "from" : "to"} watched assets`;
      return `<tr class="${isWatched ? "is-watched" : ""}"><td class="asset-cell"><span class="asset-name"><button class="watch-button" type="button" data-watch-asset="${escapeHtml(market.id)}" aria-label="${escapeHtml(watchLabel)}" title="${escapeHtml(watchLabel)}" aria-pressed="${isWatched}" ${favoritePending ? "disabled" : ""}>${isWatched ? "★" : "☆"}</button><a class="asset-link" href="${routeFor("asset", market.id)}">${escapeHtml(displayAssetName(market.id))}</a></span></td><td class="signal-cell">${renderPriceSignals(market)}</td><td class="metric">${formatPrice(market.markPrice)}</td><td class="metric ${direction}">${formatPercent(market.changePercent)}</td><td class="metric">${formatUsdCompact(market.volume24h)}</td><td class="metric">${formatUsdCompact(state.averageVolumes.get(market.id))}</td><td class="metric" title="Annualized from the current hourly funding rate">${formatPercent(annualizedFundingApr(market.funding))}</td><td class="metric" title="Wilder RSI(14) on one-hour closes; the live mark is the current-hour value">${formatRsi(rsi)}</td><td class="metric">${formatCompact(market.openInterest)}</td></tr>`;
    })
    .join("");
  const body = rows || `<tr><td class="asset-cell" colspan="9">NO MATCHING ASSETS</td></tr>`;
  elements.marketList.innerHTML = `<table class="market-table"><thead><tr>${renderSortHeader("ASSET", "asset", "asset-cell")}${renderSignalHeaders()}${renderSortHeader("MARK", "mark")}${renderSortHeader("24H +/-", "change-24h")}${renderSortHeader("24H VOL", "volume")}${renderSortHeader("AVG VOL", "avg-volume")}${renderSortHeader("APR", "apr", "", "Annualized current hourly funding rate")}${renderSortHeader("RSI", "rsi", "", "Wilder RSI(14) on one-hour closes")}${renderSortHeader("OI", "open-interest")}</tr></thead><tbody>${body}</tbody></table>`;
  state.marketRenderedAt = now;
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

function renderSignalHeaders() {
  const windows = [["1W", "1w"], ["1D", "1d"], ["6H", "6h"], ["1H", "1h"], ["30M", "30m"], ["10M", "10m"], ["5M", "5m"]];
  return `<th class="signal-cell"><span class="signal-grid signal-labels">${windows
    .map(([label, window]) => `<button class="signal-slot" type="button" data-sort-column="move-${window}" aria-label="Sort by ${label} absolute price move">${label}</button>`)
    .join("")}</span></th>`;
}

function renderSortHeader(content, column, className = "", title = "") {
  const direction = state.sort === `${column}-desc` ? "descending" : state.sort === `${column}-asc` ? "ascending" : "none";
  return `<th class="${className}" aria-sort="${direction}"${title ? ` title="${escapeHtml(title)}"` : ""}><button class="sort-header" type="button" data-sort-column="${column}">${content}</button></th>`;
}

function renderAlertOptions() {
  const selected = elements.alertAsset.value;
  elements.alertAsset.innerHTML = `<option value="">Choose asset</option>${state.watchlist
    .map((id) => {
      const market = state.markets.get(id);
      if (!market) return "";
      return `<option value="${escapeHtml(id)}">${escapeHtml(displayAssetName(market.id))} (${formatPrice(market.markPrice)})</option>`;
    })
    .join("")}`;
  if (state.watchlist.includes(selected)) elements.alertAsset.value = selected;
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
  document.querySelectorAll(".signal-dot-button.is-open").forEach((button) => {
    button.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  });
}

function handleSignalClick(event) {
  const button = event.target.closest(".signal-dot-button");
  if (!button) return;
  const asset = button.dataset.asset;
  const label = button.dataset.label;
  const willOpen = state.openDot?.asset !== asset || state.openDot?.label !== label;
  closeDotTooltips();
  state.openDot = willOpen ? { asset, label } : null;
  button.classList.toggle("is-open", willOpen);
  button.setAttribute("aria-expanded", String(willOpen));
}

async function loadAlerts() {
  if (!state.user || !state.supabase) {
    elements.alertCount.textContent = "—"; elements.listenerHealth.textContent = "SIGN IN TO LOAD";
    elements.alertList.innerHTML = `<p class="hint">Sign in to manage alerts.</p>`; return;
  }
  try {
    const [rulesResponse, runsResponse, statesResponse] = await Promise.all([
      state.supabase.from("alert_rules").select("*").is("deleted_at", null).order("created_at", { ascending: false }),
      state.supabase.from("monitor_runs").select("*").order("bucket", { ascending: false }).limit(1),
      state.supabase.from("rule_evaluation_state").select("rule_id,status,tail_percentile,updated_at"),
    ]);
    const error = rulesResponse.error ?? runsResponse.error ?? statesResponse.error; if (error) throw error;
    const rules = rulesResponse.data ?? []; const states = new Map((statesResponse.data ?? []).map((item) => [item.rule_id, item]));
    const latestDeliveryByRule = await loadLatestAlertDeliveries(rules);
    elements.listenerHealth.textContent = listenerHealth(runsResponse.data?.[0]); elements.alertCount.textContent = String(rules.filter((rule) => rule.enabled).length);
    elements.alertList.innerHTML = rules.length ? rules.map((rule) => {
      const evaluation = states.get(rule.id); const status = evaluation?.status ?? (rule.detector === "large_move" ? "warming" : "not evaluated");
      const delivery = latestDeliveryByRule.get(rule.id);
      const meta = alertStatusLabel({ enabled: rule.enabled, evaluationStatus: status, deliveryState: delivery?.state, delivery: rule.delivery });
      const deliveryError = delivery?.last_error ? ` title="${escapeHtml(delivery.last_error)}"` : "";
      return `<div class="alert-card"><span><span>${escapeHtml(displayRule(rule))} · ${rule.delivery === "sms" ? "text" : "email"}</span><br><span class="alert-meta"${deliveryError}>${escapeHtml(meta)}</span></span><span class="alert-card-actions"><button type="button" data-rule-action="${rule.enabled ? "disable" : "enable"}" data-rule-id="${escapeHtml(rule.id)}">${rule.enabled ? "off" : "on"}</button><button type="button" data-rule-action="delete" data-rule-id="${escapeHtml(rule.id)}">×</button></span></div>`;
    }).join("") : `<p class="hint">No alerts.</p>`;
  } catch (error) {
    elements.alertCount.textContent = "—";
    elements.listenerHealth.textContent = "MONITOR UNKNOWN";
    elements.alertList.innerHTML = `<p class="hint">${escapeHtml(error.message ?? "Could not load alerts.")}</p>`;
  }
}

async function loadLatestAlertDeliveries(rules) {
  const occurrenceResponses = await Promise.all(rules.map((rule) => state.supabase
    .from("alert_occurrences")
    .select("id,rule_id,bucket")
    .eq("rule_id", rule.id)
    .order("bucket", { ascending: false })
    .limit(1)
    .maybeSingle()));
  const occurrenceError = occurrenceResponses.find(({ error }) => error)?.error;
  if (occurrenceError) throw occurrenceError;
  const occurrences = occurrenceResponses.flatMap(({ data }) => data ? [data] : []);
  if (!occurrences.length) return new Map();
  const { data: deliveries, error } = await state.supabase
    .from("notification_outbox")
    .select("occurrence_id,state,attempts,last_error,updated_at")
    .in("occurrence_id", occurrences.map(({ id }) => id));
  if (error) throw error;
  const deliveryByOccurrence = new Map((deliveries ?? []).map((item) => [item.occurrence_id, item]));
  return new Map(occurrences.flatMap((occurrence) => {
    const delivery = deliveryByOccurrence.get(occurrence.id);
    return delivery ? [[occurrence.rule_id, delivery]] : [];
  }));
}

function renderAlertFields() {
  const isMove = elements.alertType.value === "large_move";
  document.querySelectorAll("[data-fixed-field]").forEach((field) => { field.hidden = isMove; field.disabled = isMove || !state.user; });
  document.querySelectorAll("[data-move-field]").forEach((field) => { field.hidden = !isMove; field.disabled = !isMove || !state.user; });
  elements.alertType.disabled = !state.user; elements.alertAsset.disabled = !state.user;
  document.querySelector("#alert-delivery").disabled = !state.user;
  elements.alertForm.querySelector("button[type=submit]").disabled = !state.user;
}

function renderRoute() {
  const { view, asset, assetView, interval, paperView, toolsView } = parseRoute(window.location.hash);
  const selectedTab = view === "asset" ? "watchlist" : view;
  elements.tabs.forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === selectedTab));
  });
  elements.views.forEach((panel) => {
    panel.hidden = panel.id !== `${view}-view`;
  });
  elements.paperTabs.forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.paperTab === paperView));
  });
  elements.paperPanels.forEach((panel) => {
    panel.hidden = panel.dataset.paperPanel !== paperView;
  });
  elements.toolsTabs.forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.toolsTab === toolsView));
  });
  elements.toolsPanels.forEach((panel) => {
    panel.hidden = panel.dataset.toolsPanel !== toolsView;
  });
  if (view === "asset") {
    updateCandleSubscription(assetView === "overview" ? asset : null, assetView === "overview" ? interval : null);
    if (assetView !== "overview") destroyAssetChart();
    renderAssetDetail(asset, assetView, interval);
  } else {
    updateCandleSubscription(null, null);
    destroyAssetChart();
  }
  const canonical = view === "asset" ? routeFor("asset", asset, assetView, interval) : routeFor(view, paperView, toolsView);
  if (window.location.hash !== canonical) window.history.replaceState(null, "", canonical);
}

function renderAssetDetail(asset, assetView = "overview", interval = "1h") {
  elements.assetDetailName.textContent = displayAssetName(asset);
  elements.assetHyperliquidLink.href = `https://app.hyperliquid.xyz/trade/${encodeURIComponent(asset)}`;
  renderAssetTabs(asset, assetView, interval);
  elements.assetPanels.forEach((panel) => { panel.hidden = panel.dataset.assetPanel !== assetView; });
  const fundamentals = state.assetFundamentals.get(asset);
  renderCompanyIdentity(asset, fundamentals, assetView);
  const retryAfter = state.assetFundamentalsErrors.get(asset) ?? 0;
  if (!fundamentals && retryAfter <= Date.now() && !state.assetFundamentalsPending.has(asset)) loadAssetFundamentals(asset);
  if (assetView === "news" && state.assetNewsAsset !== asset) loadAssetNews(asset);
  if (assetView === "overview") renderAssetIntervals(asset, interval);
  const market = state.markets.get(asset);
  if (!market) {
    if (state.assetChartAsset !== asset) destroyAssetChart();
    elements.assetDetailMetrics.innerHTML = state.catalog.length
      ? `<span><small>STATUS</small><strong>ASSET NOT FOUND</strong></span>`
      : `<span><small>STATUS</small><strong>LOADING MARKET DATA</strong></span>`;
    elements.assetDetailSignals.innerHTML = "";
    if (assetView === "overview") elements.assetChartStatus.textContent = state.catalog.length ? "ASSET NOT FOUND" : "LOADING MARKET DATA…";
    return;
  }

  const rsi = calculateHourlyRsi(state.priceHistories.get(asset) ?? [], market.markPrice);
  const metrics = [
    ["MARK", formatPrice(market.markPrice)],
    ["24H +/-", formatPercent(market.changePercent)],
    ["24H VOL", formatUsdCompact(market.volume24h)],
    ["AVG VOL", formatUsdCompact(state.averageVolumes.get(asset))],
    ["APR", formatPercent(annualizedFundingApr(market.funding))],
    ["RSI", formatRsi(rsi)],
    ["OI", formatCompact(market.openInterest)],
  ];
  elements.assetDetailMetrics.innerHTML = metrics
    .map(([label, value]) => `<span><small>${label}</small><strong>${escapeHtml(value)}</strong></span>`)
    .join("");
  if (assetView === "overview") {
    elements.assetDetailSignals.innerHTML = renderPriceSignals(market);
    if (state.assetChartAsset !== asset || state.assetChartInterval !== interval) loadAssetChart(asset, interval);
  }
}

async function loadAssetChart(asset, interval) {
  destroyAssetChart();
  state.assetChartAsset = asset;
  state.assetChartInterval = interval;
  const token = ++state.assetChartLoadToken;
  elements.assetChartStatus.textContent = `LOADING FULL ${interval.toUpperCase()} HISTORY…`;
  renderAssetBarReadout();
  try {
    state.assetChart = createAssetChart(elements.assetChart, (time) => {
      state.assetChartCursorTime = time;
      renderAssetBarReadout();
    });
    const candles = await fetchCandles(asset, interval, MAX_CANDLE_BARS);
    if (token !== state.assetChartLoadToken || state.assetChartAsset !== asset || state.assetChartInterval !== interval) return;
    const liveCandles = state.assetCandles;
    state.assetCandles = liveCandles.reduce((history, candle) => mergeLiveCandle(history, candle), candles);
    state.assetChart.setData(state.assetCandles);
    renderAssetBarReadout();
    elements.assetChartStatus.textContent = "";
  } catch (error) {
    if (token !== state.assetChartLoadToken) return;
    state.assetChart?.destroy();
    state.assetChart = null;
    elements.assetChart.replaceChildren();
    elements.assetChartStatus.textContent = error.message ?? "CHART UNAVAILABLE";
    state.assetChartRetryTimer = window.setTimeout(() => {
      state.assetChartRetryTimer = null;
      const route = parseRoute(window.location.hash);
      if (route.view === "asset" && route.asset === asset && route.assetView === "overview" && route.interval === interval) loadAssetChart(asset, interval);
    }, 15_000);
  }
}

function updateAssetCandle(rawCandle) {
  const subscription = state.assetCandleSubscription;
  if (!subscription || rawCandle?.s !== subscription.asset || rawCandle?.i !== subscription.interval) return;
  const candle = normalizeCandle(rawCandle);
  if (!candle) return;
  const merged = mergeLiveCandle(state.assetCandles, candle);
  if (merged === state.assetCandles) return;
  state.assetCandles = merged;
  state.assetChart?.update(candle);
  renderAssetBarReadout();
}

function destroyAssetChart() {
  state.assetChartLoadToken += 1;
  window.clearTimeout(state.assetChartRetryTimer);
  state.assetChartRetryTimer = null;
  state.assetChart?.destroy();
  state.assetChart = null;
  state.assetChartAsset = null;
  state.assetChartInterval = null;
  state.assetChartCursorTime = null;
  state.assetCandles = [];
  elements.assetChart.replaceChildren();
  renderAssetBarReadout();
}

function updateCandleSubscription(asset, interval) {
  const current = state.assetCandleSubscription;
  if (current?.asset === asset && current?.interval === interval) return;
  if (current) sendCandleSubscription("unsubscribe", current);
  state.assetCandleSubscription = asset && interval ? { asset, interval } : null;
  if (state.assetCandleSubscription) sendCandleSubscription("subscribe", state.assetCandleSubscription);
}

function sendCandleSubscription(method, { asset, interval }) {
  if (state.stream?.readyState !== WebSocket.OPEN) return;
  state.stream.send(JSON.stringify({ method, subscription: { type: "candle", coin: asset, interval } }));
}

function renderAssetBarReadout() {
  const cursorCandle = state.assetChartCursorTime === null
    ? null
    : findCandleByTime(state.assetCandles, state.assetChartCursorTime);
  const candle = cursorCandle ?? state.assetCandles.at(-1);
  if (!candle) {
    elements.assetBarReadout.textContent = "NO BAR DATA";
    return;
  }
  const values = [
    ["TIME", formatBarTime(candle.time)],
    ["O", formatPrice(candle.open)],
    ["H", formatPrice(candle.high)],
    ["L", formatPrice(candle.low)],
    ["C", formatPrice(candle.close)],
    ["VOL", formatCompact(candle.volume)],
    ["TRADES", Number.isFinite(candle.trades) ? candle.trades.toLocaleString() : "—"],
  ];
  elements.assetBarReadout.innerHTML = values.map(([label, value]) => `<span>${label}<strong>${escapeHtml(value)}</strong></span>`).join("");
}

function renderAssetIntervals(asset, interval) {
  if (elements.assetIntervals.dataset.asset === asset && elements.assetIntervals.dataset.interval === interval) return;
  elements.assetIntervals.dataset.asset = asset;
  elements.assetIntervals.dataset.interval = interval;
  elements.assetIntervals.innerHTML = CANDLE_INTERVALS.map(({ value, label }) => (
    `<a href="${routeFor("asset", asset, "overview", value)}"${value === interval ? ' aria-current="page"' : ""}>${label}</a>`
  )).join("");
}

function renderAssetTabs(asset, assetView, interval) {
  const key = `${asset}:${assetView}:${interval}`;
  if (elements.assetTabs.dataset.key === key) return;
  elements.assetTabs.dataset.key = key;
  elements.assetTabs.innerHTML = ["overview", "news", "financials"].map((view) => (
    `<a href="${routeFor("asset", asset, view, interval)}"${view === assetView ? ' aria-current="page"' : ""}>${view.toUpperCase()}</a>`
  )).join("");
}

function renderCompanyIdentity(asset, data, assetView) {
  const identity = data?.identity;
  elements.assetDetailOfficialName.textContent = identity?.displayName && identity.displayName !== displayAssetName(asset)
    ? identity.displayName.toUpperCase()
    : "";
  if (assetView === "overview") {
    const profileKey = `${asset}:${identity?.source ?? "loading"}:${identity?.description ?? ""}`;
    if (elements.assetCompanyProfile.dataset.key !== profileKey) {
      elements.assetCompanyProfile.dataset.key = profileKey;
      elements.assetCompanyProfile.innerHTML = identity?.description
        ? `<p>${escapeHtml(identity.description)}</p><small>${escapeHtml(companySourceLabel(identity.source))}</small>`
        : `<p class="hint">${data ? "NO COMPANY DESCRIPTION IS AVAILABLE FOR THIS INSTRUMENT." : "LOADING COMPANY PROFILE…"}</p>`;
    }
  }
  if (assetView === "financials") renderFinancials(data, (state.assetFundamentalsErrors.get(asset) ?? 0) > Date.now());
}

async function loadAssetFundamentals(asset) {
  state.assetFundamentalsPending.add(asset);
  try {
    const data = await fetchAssetFundamentals(state.supabase, asset);
    state.assetFundamentals.set(asset, data);
    state.assetFundamentalsErrors.delete(asset);
    const route = parseRoute(window.location.hash);
    if (route.view === "asset" && route.asset === asset) {
      renderCompanyIdentity(asset, data, route.assetView);
    }
  } catch (error) {
    state.assetFundamentalsErrors.set(asset, Date.now() + 60_000);
    const route = parseRoute(window.location.hash);
    if (route.view === "asset" && route.asset === asset) {
      elements.assetDetailOfficialName.textContent = "";
      if (route.assetView === "overview") elements.assetCompanyProfile.innerHTML = `<p class="hint">${escapeHtml(error.message ?? "COMPANY PROFILE UNAVAILABLE")}</p>`;
      if (route.assetView === "financials") {
        elements.assetFinancialsStatus.textContent = "UNAVAILABLE";
        elements.assetFinancialsContent.innerHTML = `<p class="asset-news-empty">${escapeHtml(error.message ?? "FINANCIALS UNAVAILABLE")}</p>`;
      }
    }
  } finally {
    state.assetFundamentalsPending.delete(asset);
  }
}

function renderFinancials(data, retrying = false) {
  if (!data) {
    elements.assetFinancialsStatus.textContent = retrying ? "TEMPORARILY UNAVAILABLE · RETRYING" : "LOADING";
    if (!retrying || !elements.assetFinancialsContent.textContent) {
      elements.assetFinancialsContent.innerHTML = `<p class="asset-news-empty">${retrying ? "YAHOO FINANCE DATA IS TEMPORARILY UNAVAILABLE." : "LOADING YAHOO FINANCE DATA…"}</p>`;
    }
    return;
  }
  const date = data.updatedAt ? new Date(data.updatedAt) : null;
  elements.assetFinancialsStatus.textContent = data.available
    ? `YAHOO FINANCE · ${date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "LATEST"}`
    : "NOT AVAILABLE ON YAHOO FINANCE";
  if (!data.available) {
    elements.assetFinancialsContent.innerHTML = '<p class="asset-news-empty">NO COMPANY FINANCIAL STATEMENTS ARE AVAILABLE FOR THIS INSTRUMENT.</p>';
    return;
  }
  const renderKey = `${data.identity.yahooSymbol}:${data.updatedAt}:${data.metrics.length}:${data.quarters.length}`;
  if (elements.assetFinancialsContent.dataset.key === renderKey) return;
  elements.assetFinancialsContent.dataset.key = renderKey;
  const metrics = data.metrics.map((metric) => (
    `<span><small>${escapeHtml(String(metric.label || ""))}</small><strong>${escapeHtml(formatFinancialValue(metric.value, metric.format, data.currency))}</strong><em>${escapeHtml(String(metric.asOfDate || ""))}</em></span>`
  )).join("");
  const rows = data.quarters.map((quarter) => `<tr><th scope="row">${escapeHtml(String(quarter.date || ""))}</th>${["revenue", "grossProfit", "operatingIncome", "netIncome", "dilutedEps", "freeCashFlow"].map((key) => `<td>${escapeHtml(formatFinancialValue(quarter[key], key === "dilutedEps" ? "number" : "currency", data.currency))}</td>`).join("")}</tr>`).join("");
  elements.assetFinancialsContent.innerHTML = `<div class="financial-metrics">${metrics}</div>${rows ? `<div class="financial-table-wrap"><table class="financial-table"><thead><tr><th>QUARTER</th><th>REVENUE</th><th>GROSS PROFIT</th><th>OPERATING INCOME</th><th>NET INCOME</th><th>DILUTED EPS</th><th>FREE CASH FLOW</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}<p class="financial-source">SOURCE: YAHOO FINANCE INTERNAL WEB DATA · VALUES MAY BE DELAYED OR RESTATED.</p>`;
}

function formatFinancialValue(value, format, currency) {
  if (!Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  if (format === "percent") return `${(number * 100).toFixed(2)}%`;
  if (format === "ratio" || format === "number") return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${currency ? `${currency} ` : ""}${formatCompact(number)}`;
}

function companySourceLabel(source) {
  if (source === "yahoo+wikipedia") return "OFFICIAL NAME: YAHOO FINANCE · DESCRIPTION: WIKIPEDIA";
  if (source === "curated") return "INSTRUMENT DESCRIPTION";
  return "COMPANY PROFILE";
}

function findCandleByTime(candles, time) {
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time === time) return candles[middle];
    if (candles[middle].time < time) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

async function loadAssetNews(asset) {
  state.assetNewsAsset = asset;
  const token = ++state.assetNewsLoadToken;
  elements.assetNewsStatus.textContent = "LOADING";
  elements.assetNewsList.innerHTML = '<p class="asset-news-empty">LOADING PUBLIC MARKET NEWS…</p>';
  try {
    const items = await fetchAssetNews(state.supabase, asset);
    if (token !== state.assetNewsLoadToken || state.assetNewsAsset !== asset) return;
    elements.assetNewsStatus.textContent = `${items.length} ITEMS`;
    elements.assetNewsList.innerHTML = items.length ? items.map((item) => (
      `<a class="asset-news-item" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><span class="asset-news-title">${escapeHtml(item.title)}</span><small class="asset-news-meta">${escapeHtml(item.source.toUpperCase())} · ${escapeHtml(formatNewsTime(item.publishedAt))} · ${escapeHtml(item.topic)}</small></a>`
    )).join("") : '<p class="asset-news-empty">NO RECENT PUBLIC COVERAGE FOUND.</p>';
  } catch (error) {
    if (token !== state.assetNewsLoadToken) return;
    elements.assetNewsStatus.textContent = "UNAVAILABLE";
    elements.assetNewsList.innerHTML = `<p class="asset-news-empty">${escapeHtml(error.message ?? "NEWS UNAVAILABLE")}</p>`;
  }
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
    const subscriptions = new Set([...tradFiMarkets().map(({ id }) => id), ...state.watchlist]);
    subscriptions.forEach((coin) => {
      stream.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "activeAssetCtx", coin },
      }));
    });
    if (state.assetCandleSubscription) sendCandleSubscription("subscribe", state.assetCandleSubscription);
    renderConnectionStatus();
  });

  stream.addEventListener("message", ({ data }) => {
    if (state.stream !== stream) return;
    state.streamMessageAt = Date.now();
    renderConnectionStatus();
    const message = JSON.parse(data);
    if (message.channel === "candle") {
      updateAssetCandle(message.data);
      return;
    }
    if (message.channel !== "activeAssetCtx") return;
    const market = state.markets.get(message.data.coin);
    if (!market) return;
    const updatedMarket = applyLiveMarketContext(market, message.data.ctx);
    state.markets.set(message.data.coin, updatedMarket);
    recordLivePrice(message.data.coin, updatedMarket.markPrice);
    updateLastSync();
    scheduleMarketRender();
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

function tradFiMarkets() {
  return hydrateTradFiMarkets(state.catalog, state.markets);
}

function scheduleMarketRender() {
  if (state.marketRenderTimer) return;
  const delayMs = Math.max(0, 1_000 - (Date.now() - state.marketRenderedAt));
  state.marketRenderTimer = window.setTimeout(() => {
    state.marketRenderTimer = null;
    renderMarkets();
    renderAlertOptions();
    const route = parseRoute(window.location.hash);
    if (route.view === "asset") renderAssetDetail(route.asset, route.assetView, route.interval);
  }, delayMs);
}

function recordLivePrice(asset, price, now = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) return;
  const bucket = Math.floor(now / 300_000) * 300_000;
  const points = state.priceHistories.get(asset) ?? [];
  const recent = points.filter((point) => point.time >= now - (8 * 24 * 60 * 60 * 1000));
  if (recent.at(-1)?.time >= bucket) recent[recent.length - 1] = { time: bucket, price };
  else recent.push({ time: bucket, price });
  state.priceHistories.set(asset, recent);
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

function formatBarTime(seconds) {
  return UTC_MINUTE_FORMATTER.format(new Date(seconds * 1000)).toUpperCase();
}

function formatNewsTime(value) {
  return `${UTC_MINUTE_FORMATTER.format(new Date(value)).toUpperCase()} UTC`;
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

function formatRsi(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "—";
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
