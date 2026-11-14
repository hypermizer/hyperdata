import { APP_CONFIG } from "./config.js?v=20261109-owner";
import { createAlertRuntimeClient } from "./lib/alert-client.js?v=20261109-owner";
import { createAssetChart } from "./asset-chart.js?v=20261109-owner";
import { createAssetLiquidations } from "./asset-liquidations.js?v=20261109-owner";
import { alertDeliverySummary, displayRule, listenerHealth, priceStreamHealth, normalizeAlertRuleInput } from "./lib/alert-rules.js?v=20261110-charts3";
import { ASSET_CATEGORY_TABS, calculateDailyVolatility, calculateHourlyRsi, displayAssetSymbol, filterAssets, formatFundingApr, formatMaxLeverage, hydrateAssetUniverse, isNewAsset, nextColumnSort, sortAssets, unseenNewAssetIds } from "./lib/assets.js?v=20261113-dot-sort";
import { applyAssetAnalyticsRows, applyMarkReferenceSnapshot, recordLivePricePoint } from "./lib/asset-analytics.js?v=20261110-marks";
import {
  applyLiveMarketContext,
  buildPriceChangeSignals,
  CANDLE_INTERVALS,
  fetchCandles,
  mapAllDexsAssetContexts,
  MAX_CANDLE_BARS,
  mergeLiveCandle,
  normalizeCandle,
} from "./lib/hyperliquid.js?v=20261110-marks";
import { getAssetMarketCatalog } from "./lib/market-catalog.js?v=20261110-charts3";
import { createChartGrid } from "./charts.js?v=20261110-charts3";
import { createPairView } from "./pair.js?v=20261114-pair2";
import { fetchAssetFundamentals } from "./lib/fundamentals.js?v=20260801";
import { fetchAssetNews } from "./lib/news.js?v=20260801-ranked";
import { createWatchlistClient } from "./lib/supabase.js?v=20261110-charts3";
import { deriveStreamHealth } from "./lib/stream-health.js?v=20260720-stream";
import { parseRoute, routeFor } from "./lib/routes.js?v=20261114-pair2";

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
  alertClient: createAlertRuntimeClient(APP_CONFIG),
  alertReady: false,
  alertOptionsKey: "",
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
  assetNewsRetryTimer: null,
  catalogRetryTimer: null,
  acknowledgedNewAssets: new Set(),
  acknowledgementPending: new Set(),
  analyticsHistoryLoaded: new Set(),
  analyticsHistoryLoading: false,
  analyticsHistorySince: null,
  analyticsHistoryRetryTimer: null,
  averageVolumes: new Map(),
  catalog: [],
  category: "all",
  favoritePending: new Set(),
  firstSeenAt: new Map(),
  markets: new Map(),
  openDot: null,
  priceHistories: new Map(),
  markHistories: new Map(),
  dotReferencesLoading: false,
  dotReferenceAsOf: 0,
  dotReferenceMissing: 0,
  dotVolatility: new Map(),
  supabase: createWatchlistClient(APP_CONFIG),
  stream: null,
  streamMessageAt: 0,
  streamOpenedAt: 0,
  streamPhase: "loading",
  streamStartedAt: 0,
  reconnectTimer: null,
  marketRenderTimer: null,
  marketRenderedAt: 0,
  pendingMarketContexts: new Map(),
  query: "",
  sort: "asset-asc",
  user: null,
  watchedFirst: false,
  watchlist: [],
  watchlistReady: false,
};

const elements = {
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
  assetCategoryTabs: [...document.querySelectorAll("[data-asset-category]")],
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
  analysisTabs: [...document.querySelectorAll("[data-analysis-tab]")],
  analysisPanels: [...document.querySelectorAll("[data-analysis-panel]")],
  paperTabs: [...document.querySelectorAll("[data-paper-tab]")],
  paperPanels: [...document.querySelectorAll("[data-paper-panel]")],
  watchlistMessage: document.querySelector("#watchlist-message"),
  watchedFirst: document.querySelector("#watched-first"),
};

const liquidationView = createAssetLiquidations(state.alertClient, (asset) => state.markets.get(asset)?.markPrice);
const chartGrid = createChartGrid({ client: state.supabase, getAssets: () => state.watchlist, getMarket: (asset) => state.markets.get(asset), getReady: () => state.watchlistReady });
const pairView = createPairView({ client: state.supabase, getCatalog: () => state.catalog });
wireEvents();
initialize();

async function initialize() {
  renderRoute();
  void loadAlerts();
  const marketReady = initializeMarketData();
  await restoreWatchlistStorage();
  await marketReady;
}

async function restoreWatchlistStorage() {
  try { await initializeWatchlistStorage(); }
  catch {
    setAccountMessage("WATCHLIST SYNC RETRYING…");
    window.setTimeout(restoreWatchlistStorage, 5000);
  }
}

async function initializeMarketData() {
  window.clearTimeout(state.catalogRetryTimer);
  try {
    const markets = await getAssetMarketCatalog();
    state.catalog = markets;
    updateMarketMap(markets);
    if (!assetUniverseMarkets().length) throw new Error("No supported Hyperliquid markets were returned.");
    ensureValidWatchlist();
    render();
    connectMarketStream();
    void loadDotReferences();
    void loadCachedAssetAnalytics();
    void loadCachedAssetHistories(markets.map(({ id }) => id));
  } catch (error) {
    state.streamPhase = "error";
    renderConnectionStatus(error.message);
    elements.marketList.textContent = "Market data unavailable.";
    state.catalogRetryTimer = window.setTimeout(initializeMarketData, 3_000);
  }
}

function wireEvents() {
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
  elements.assetCategoryTabs.forEach((button) => button.addEventListener("click", () => {
    const category = button.dataset.assetCategory;
    if (!ASSET_CATEGORY_TABS.some(({ value }) => value === category) || category === state.category) return;
    state.category = category;
    elements.assetCategoryTabs.forEach((categoryButton) => {
      categoryButton.setAttribute("aria-pressed", String(categoryButton === button));
    });
    renderMarkets();
  }));
  window.addEventListener("hashchange", renderRoute);
  renderRoute();

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
    const acknowledgementButton = event.target.closest("[data-acknowledge-new-asset]");
    if (acknowledgementButton) {
      await acknowledgeNewAsset(acknowledgementButton.dataset.acknowledgeNewAsset);
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
      if (!state.alertReady) throw new Error("Connect to the private alert runtime first.");
      const form = new FormData(elements.alertForm);
      const detector = form.get("detector");
      const normalized = normalizeAlertRuleInput({ asset: form.get("asset"), detector, delivery: form.get("delivery"),
        direction: detector === "fixed_price" ? form.get("direction") : form.get("moveDirection"), target: form.get("target"),
        horizonMinutes: form.get("horizonMinutes"), tailPercentile: form.get("tailPercentile"), minimumMovePercent: form.get("minimumMovePercent") });
      await state.alertClient.create(normalized);
      elements.alertMessage.textContent = "Alert created.";
      await loadAlerts();
    } catch (error) {
      elements.alertMessage.textContent = error.message;
    } finally {
      submitButton.disabled = !state.alertReady;
    }
  });

  elements.alertList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-rule-action]");
    if (!button || !state.alertReady) return;
    button.disabled = true; elements.alertMessage.textContent = "";
    const action = button.dataset.ruleAction; const id = button.dataset.ruleId;
    try { await state.alertClient.change(id, action); }
    catch (error) { elements.alertMessage.textContent = error.message; }
    await loadAlerts();
  });

  setInterval(() => {
    void loadCachedAssetAnalytics();
    if (state.catalog.length) void loadCachedAssetHistories(state.catalog.map(({id}) => id));
  }, APP_CONFIG.assetAnalyticsCachePollIntervalMs);
  setInterval(loadDotReferences,15000);
  setInterval(async()=>{
    if(document.hidden)return;
    try{
      const markets=await getAssetMarketCatalog({refresh:true});
      state.catalog=markets;
      for(const market of markets){
        const current=state.markets.get(market.id);
        state.markets.set(market.id,current?applyLiveMarketContext(market,{markPx:current.markPriceRaw??current.markPrice,prevDayPx:current.previousPrice,dayNtlVlm:current.volume24h,openInterest:current.openInterest,funding:current.funding}):market);
      }
      void loadDotReferences();void loadCachedAssetHistories(markets.map(m=>m.id));scheduleMarketRender();
    }catch(error){console.warn("Asset discovery is retrying",error);}
  },300000);
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
  if (state.user) {
    state.accountMessage = "";
    await Promise.all([loadCloudWatchlist(), loadNewAssetAcknowledgements(), loadAlerts()]);
  } else {
    state.watchlist = [...APP_CONFIG.initialWatchlist].filter((id) => state.markets.size === 0 || state.markets.has(id));
    state.acknowledgedNewAssets = new Set();
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

async function loadCloudWatchlist() {
  const { data, error } = await state.supabase
    .from("watchlist_items")
    .select("asset")
    .order("created_at");
  if (error) throw error;
  state.watchlist = data.map((item) => item.asset);
  state.watchlistReady = true;
  dispatchWatchlist();
}

async function loadNewAssetAcknowledgements() {
  const { data, error } = await state.supabase
    .from("new_asset_acknowledgements")
    .select("asset");
  if (error) throw error;
  state.acknowledgedNewAssets = new Set(data.map((item) => item.asset));
}

function dispatchWatchlist() {
  window.dispatchEvent(new CustomEvent("hyperdata:watchlist", { detail: { assets: [...state.watchlist] } }));
}

function renderAccount() {
  elements.accountStatus.textContent = state.accountMessage || (state.user ? "PRIVATE OWNER SESSION" : "CONNECTING TO PRIVATE SESSION");
}

async function toggleWatchedAsset(asset) {
  if (state.favoritePending.has(asset)) return;
  if (!state.watchlistReady) { setWatchlistMessage("Watchlist is syncing. Please wait."); return; }
  if (!state.user) {
    setWatchlistMessage("Private owner session is unavailable. Reload through the gateway.");
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

async function acknowledgeNewAsset(asset) {
  if (state.acknowledgedNewAssets.has(asset) || state.acknowledgementPending.has(asset)) return;
  if (!state.user) {
    setWatchlistMessage("Open the private gateway to save seen assets.");
    return;
  }
  state.acknowledgementPending.add(asset);
  state.acknowledgedNewAssets.add(asset);
  renderMarkets();
  try {
    const { error } = await state.supabase
      .from("new_asset_acknowledgements")
      .upsert({ user_id: state.user.id, asset }, { onConflict: "user_id,asset" });
    if (error) throw error;
    setWatchlistMessage(`${displayAssetName(asset)} marked as seen.`);
  } catch (error) {
    state.acknowledgedNewAssets.delete(asset);
    setWatchlistMessage(error.message);
  } finally {
    state.acknowledgementPending.delete(asset);
    renderMarkets();
  }
}

async function loadDotReferences(){
  if(!state.supabase||state.dotReferencesLoading)return;
  state.dotReferencesLoading=true;
  try{
    const {data,error}=await state.supabase.rpc("asset_mark_reference_snapshot",{});
    if(error)throw error;
    const applied=applyMarkReferenceSnapshot(data,state.markHistories);
    state.dotReferenceAsOf=applied.asOf;
    state.dotVolatility=new Map(data.rows.map(row=>[row.asset,Number(row.five_minute_volatility)]));
    state.dotReferenceMissing=data.rows.reduce((n,row)=>n+Math.max(0,7-row.mark_history.length),0);
    renderConnectionStatus();
    if(state.catalog.length)scheduleMarketRender();
  }catch(error){console.warn("Mark references are retrying",error);}
  finally{state.dotReferencesLoading=false;}
}

async function loadCachedAssetAnalytics() {
  if (!state.supabase) return 0;
  const { data, error } = await state.supabase
    .from("asset_analytics_cache")
    .select("asset,average_daily_volume,first_seen_at");
  if (error) return 0;
  const applied = applyAssetAnalyticsRows(data, state);
  if (applied && state.catalog.length) scheduleMarketRender();
  return applied;
}

async function loadCachedAssetHistories(assetIds) {
  if (!state.supabase || state.analyticsHistoryLoading) return;
  state.analyticsHistoryLoading = true;
  window.clearTimeout(state.analyticsHistoryRetryTimer);
  const missing = assetIds.filter(asset => !state.analyticsHistoryLoaded.has(asset));
  const watched = new Set(state.watchlist);
  const pending = missing.sort((a,b) => Number(watched.has(b))-Number(watched.has(a)));
  try {
    for (let index=0; index<pending.length; index+=20) {
      const batch=pending.slice(index,index+20);
      const {data,error}=await state.supabase.rpc("asset_history_updates",{p_since:null,p_assets:batch});
      if (error) throw error;
      applyAssetAnalyticsRows(data.rows,state);
      state.analyticsHistorySince ??= data.asOf;
      batch.forEach(asset=>state.analyticsHistoryLoaded.add(asset));
      if (state.catalog.length) scheduleMarketRender();
    }
    // Bound each response, including after a phone resumes from a long sleep.
    // Keep the first server watermark so updates during later batches are replayed.
    let nextSince=null;
    for(let index=0;index<assetIds.length;index+=20){
      const {data,error}=await state.supabase.rpc("asset_history_updates",{p_since:state.analyticsHistorySince,p_assets:assetIds.slice(index,index+20)});
      if(error)throw error;
      applyAssetAnalyticsRows(data.rows,state);
      nextSince??=data.asOf;
    }
    state.analyticsHistorySince=nextSince??state.analyticsHistorySince;
    if (state.catalog.length) scheduleMarketRender();
  } catch(error) {
    console.warn("Asset price history refresh failed; retrying",error);
    state.analyticsHistoryRetryTimer=window.setTimeout(()=>loadCachedAssetHistories(assetIds),15000);
  } finally { state.analyticsHistoryLoading=false; }
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
  const markets = assetUniverseMarkets();
  const categoryMarkets = filterAssets(markets, {
    category: state.category,
    firstSeenAt: state.firstSeenAt,
    now,
  });
  const totalAssets = categoryMarkets.length;
  const filteredMarkets = filterAssets(markets, {
    category: state.category,
    firstSeenAt: state.firstSeenAt,
    now,
    query: state.query,
  });
  const rsiValues = new Map(filteredMarkets.map((market) => [
    market.id,
    calculateHourlyRsi(state.priceHistories.get(market.id) ?? [], market.markPrice, now),
  ]));
  const dailyVolatilityValues = new Map(filteredMarkets.map((market) => [
    market.id,
    calculateDailyVolatility(state.priceHistories.get(market.id) ?? [], market.markPrice, now),
  ]));
  const visibleMarkets = sortAssets(filteredMarkets, {
    averageVolumes: state.averageVolumes,
    dailyVolatilityValues,
    now,
    priceHistories: state.markHistories,
    rsiValues,
    sort: state.sort,
    watched: state.watchlist,
    watchedFirst: state.watchedFirst,
  });
  const watched = new Set(state.watchlist);
  const symbolCounts = new Map(markets.map((market) => [displayAssetSymbol(market), 0]));
  markets.forEach((market) => symbolCounts.set(displayAssetSymbol(market), (symbolCounts.get(displayAssetSymbol(market)) ?? 0) + 1));
  const newAssetCount = markets.filter((market) => isNewAsset(market, state.firstSeenAt, now)).length;
  const unseenNewAssets = unseenNewAssetIds(markets, state.firstSeenAt, state.acknowledgedNewAssets, now);
  const newCategoryButton = elements.assetCategoryTabs.find((button) => button.dataset.assetCategory === "new");
  newCategoryButton?.classList.toggle("has-new-assets", unseenNewAssets.length > 0);
  if (newCategoryButton) newCategoryButton.title = `${newAssetCount} ASSET${newAssetCount === 1 ? "" : "S"} ADDED IN THE LAST 7 DAYS · ${unseenNewAssets.length} UNSEEN`;
  elements.assetCount.textContent = state.query.trim()
    ? `${visibleMarkets.length} / ${totalAssets} ASSETS`
    : `${totalAssets} ASSETS`;
  const rows = visibleMarkets
    .map((market) => {
      const direction = market.changePercent >= 0 ? "positive" : "negative";
      const isWatched = watched.has(market.id);
      const favoritePending = state.favoritePending.has(market.id);
      const rsi = rsiValues.get(market.id);
      const dailyVolatility = dailyVolatilityValues.get(market.id);
      const acknowledgement = renderNewAssetAcknowledgement(market);
      const watchLabel = `${isWatched ? "Remove" : "Add"} ${displayAssetName(market.id)} ${isWatched ? "from" : "to"} watched assets`;
      const venue = symbolCounts.get(displayAssetSymbol(market)) > 1
        ? `<span class="asset-venue-tag" title="Hyperliquid venue">${escapeHtml(market.dexId || "CORE")}</span>`
        : "";
      return `<tr data-mark-price="${escapeHtml(String(market.markPriceRaw??market.markPrice))}" class="${isWatched ? "is-watched" : ""}"><td class="asset-cell"><span class="asset-name"><button class="watch-button" type="button" data-watch-asset="${escapeHtml(market.id)}" aria-label="${escapeHtml(watchLabel)}" title="${escapeHtml(watchLabel)}" aria-pressed="${isWatched}" ${favoritePending ? "disabled" : ""}>${isWatched ? "★" : "☆"}</button><a class="asset-link" href="${routeFor("asset", market.id)}">${escapeHtml(displayAssetName(market.id))}</a>${venue}<span class="asset-leverage-tag" title="Maximum leverage">${formatMaxLeverage(market.maxLeverage)}</span>${acknowledgement}</span></td><td class="signal-cell">${renderPriceSignals(market)}</td><td class="metric">${formatPrice(market.markPrice)}</td><td class="metric ${direction}">${formatPercent(market.changePercent)}</td><td class="metric">${formatUsdCompact(market.volume24h)}</td><td class="metric">${formatUsdCompact(state.averageVolumes.get(market.id))}</td><td class="metric" title="20-day standard deviation of daily log returns, including the live mark">${formatVolatility(dailyVolatility)}</td><td class="metric" title="Annualized from the current hourly funding rate">${formatFundingApr(market.funding)}</td><td class="metric" title="Wilder RSI(14) on one-hour closes; the live mark is the current-hour value">${formatRsi(rsi)}</td><td class="metric" title="Open-interest notional at the current mark">${formatUsdCompact(market.openInterestNotional)}</td></tr>`;
    })
    .join("");
  const body = rows || `<tr><td class="asset-cell" colspan="10">NO MATCHING ASSETS</td></tr>`;
  elements.marketList.innerHTML = `<table class="market-table"><thead><tr>${renderSortHeader("ASSET", "asset", "asset-cell")}${renderSignalHeaders()}${renderSortHeader("MARK", "mark")}${renderSortHeader("24H +/-", "change-24h")}${renderSortHeader("24H VOL", "volume")}${renderSortHeader("AVG VOL", "avg-volume")}${renderSortHeader("D VOL", "daily-volatility", "", "20-day realized volatility")}${renderSortHeader("APR", "apr", "", "Annualized current hourly funding rate")}${renderSortHeader("RSI", "rsi", "", "Wilder RSI(14) on one-hour closes")}${renderSortHeader("OI", "open-interest")}</tr></thead><tbody>${body}</tbody></table>`;
  state.marketRenderedAt = now;
}

function renderNewAssetAcknowledgement(market) {
  if (state.category !== "new") return "";
  const isAcknowledged = state.acknowledgedNewAssets.has(market.id);
  const label = isAcknowledged
    ? `${displayAssetName(market.id)} seen`
    : `Mark ${displayAssetName(market.id)} as seen`;
  const disabled = isAcknowledged || state.acknowledgementPending.has(market.id);
  return `<button class="new-asset-acknowledgement" type="button" data-acknowledge-new-asset="${escapeHtml(market.id)}" aria-label="${escapeHtml(label)}" aria-pressed="${isAcknowledged}" title="${isAcknowledged ? "Seen" : "Mark as seen"}" ${disabled ? "disabled" : ""}>✓</button>`;
}

function renderPriceSignals(market) {
  const signals = buildPriceChangeSignals(
    market.markPrice,
    state.markHistories.get(market.id) ?? [],
    Date.now(),
    [],
    state.dotVolatility.get(market.id),
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
    .map(([label, window]) => {
      const descending = state.sort === `move-${window}-desc`;
      const ascending = state.sort === `move-${window}-asc`;
      const active = descending || ascending;
      const description = `${label} return${active ? `, ${descending ? "highest" : "lowest"} first` : ""}. Sort ${descending ? "lowest" : "highest"} return first`;
      return `<button class="signal-slot" type="button" data-sort-column="move-${window}" aria-pressed="${active}" aria-label="${description}" title="${description}">${label}<span class="signal-sort-indicator" aria-hidden="true">${descending ? "↓" : ascending ? "↑" : ""}</span></button>`;
    })
    .join("")}</span></th>`;
}

function renderSortHeader(content, column, className = "", title = "") {
  const direction = state.sort === `${column}-desc` ? "descending" : state.sort === `${column}-asc` ? "ascending" : "none";
  return `<th class="${className}" aria-sort="${direction}"${title ? ` title="${escapeHtml(title)}"` : ""}><button class="sort-header" type="button" data-sort-column="${column}">${content}</button></th>`;
}

function renderAlertOptions() {
  const selected = elements.alertAsset.value;
  const available = assetUniverseMarkets().map((market) => market.id);
  const watched = state.watchlist.filter((id) => available.includes(id));
  const watchedSet = new Set(watched);
  const others = available.filter((id) => !watchedSet.has(id)).sort((a, b) => displayAssetName(a).localeCompare(displayAssetName(b)));
  const key = [...watched, "|", ...others].join(",");
  const label = (id) => `${displayAssetName(id)}${id.includes(":") ? ` · ${id.split(":")[0]}` : ""}`;
  if (key !== state.alertOptionsKey) {
    const options = (ids) => ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(label(id))}</option>`).join("");
    elements.alertAsset.innerHTML = `<option value="">Choose asset</option>${watched.length ? `<optgroup label="Watched">${options(watched)}</optgroup>` : ""}<optgroup label="All assets">${options(others)}</optgroup>`;
    if (available.includes(selected)) elements.alertAsset.value = selected;
    state.alertOptionsKey = key;
  }
  const current = elements.alertAsset.selectedOptions[0];
  const market = state.markets.get(current?.value);
  if (market) current.textContent = `${label(market.id)} (${formatPrice(market.markPrice)})`;
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
  if (!state.alertClient.sameOrigin) {
    state.alertReady = false;
    elements.alertCount.textContent = "—";
    elements.listenerHealth.textContent = "PRIVATE SERVER";
    elements.alertList.innerHTML = state.alertClient.url
      ? `<p class="hint"><a href="${escapeHtml(state.alertClient.url)}/#/alerts">Open your private server to manage alerts</a> using your browser client certificate.</p>`
      : `<p class="hint">The private alert runtime is being configured.</p>`;
    renderAlertFields(); return;
  }
  try {
    const snapshot = await state.alertClient.list();
    state.alertReady = true;
    const rules = snapshot.rules ?? [];
    const rawStream = snapshot.health.find((row) => row.worker_id === "stream");
    const stream = rawStream ? { ...rawStream.details, heartbeat_at: rawStream.heartbeat_at } : null;
    const fallback = snapshot.health.find((row) => row.worker_id === "fallback");
    const monitor = fallback ? { state: fallback.details.state, finished_at: fallback.heartbeat_at } : null;
    elements.listenerHealth.textContent = `${priceStreamHealth(stream)} · ${listenerHealth(monitor)}`;
    elements.alertCount.textContent = String(rules.filter((rule) => rule.enabled).length);
    elements.alertList.innerHTML = rules.length ? rules.map((rule) => {
      const status = rule.evaluation?.status ?? (rule.detector === "large_move" ? "warming"
        : priceStreamHealth(stream) === "LIVE PRICE STREAM HEALTHY" && Date.parse(stream.rules_refreshed_at) >= Date.parse(rule.updated_at) ? "not_triggered" : "not evaluated");
      const meta = alertDeliverySummary(rule.deliveries, { enabled: rule.enabled, evaluationStatus: status, delivery: "ntfy" });
      const errors = rule.deliveries?.map((row) => row.last_error).filter(Boolean).join("; ");
      const title = errors ? ` title="${escapeHtml(errors)}"` : "";
      return `<div class="alert-card"><span><span>${escapeHtml(displayRule(rule))} · iPhone (ntfy)</span><br><span class="alert-meta"${title}>${escapeHtml(meta)}</span></span><span class="alert-card-actions"><button type="button" data-rule-action="${rule.enabled ? "disable" : "enable"}" data-rule-id="${escapeHtml(rule.id)}">${rule.enabled ? "off" : "on"}</button><button type="button" data-rule-action="delete" data-rule-id="${escapeHtml(rule.id)}">×</button></span></div>`;
    }).join("") : `<p class="hint">No alerts.</p>`;
  } catch (error) {
    state.alertReady = false;
    elements.alertCount.textContent = "—";
    elements.listenerHealth.textContent = "RUNTIME UNAVAILABLE";
    elements.alertList.innerHTML = `<p class="hint">${escapeHtml(error.message ?? "Could not load alerts.")}</p>`;
  }
  renderAlertFields();
}

function renderAlertFields() {
  const isMove = elements.alertType.value === "large_move";
  document.querySelectorAll("[data-fixed-field]").forEach((field) => { field.hidden = isMove; field.disabled = isMove || !state.alertReady; });
  document.querySelectorAll("[data-move-field]").forEach((field) => { field.hidden = !isMove; field.disabled = !isMove || !state.alertReady; });
  elements.alertType.disabled = !state.alertReady; elements.alertAsset.disabled = !state.alertReady;
  document.querySelector("#alert-delivery").disabled = !state.alertReady;
  elements.alertForm.querySelector("button[type=submit]").disabled = !state.alertReady;
}

function renderRoute() {
  const { view, asset, assetView, interval, analysisView, paperView } = parseRoute(window.location.hash);
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
  elements.analysisTabs.forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.analysisTab === analysisView));
  });
  elements.analysisPanels.forEach((panel) => {
    panel.hidden = panel.dataset.analysisPanel !== analysisView;
  });
  chartGrid.setActive(view === "charts");
  pairView.setActive(view === "pair");
  if (view === "asset") {
    updateCandleSubscription(assetView === "overview" ? asset : null, assetView === "overview" ? interval : null);
    if (assetView !== "overview") destroyAssetChart();
    renderAssetDetail(asset, assetView, interval);
  } else {
    updateCandleSubscription(null, null);
    destroyAssetChart();
  }
  const canonical = view === "asset"
    ? routeFor("asset", asset, assetView, interval)
    : view === "analysis"
      ? routeFor("analysis", analysisView)
      : routeFor(view, paperView);
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
    ["APR", formatFundingApr(market.funding)],
    ["RSI", formatRsi(rsi)],
    ["OI", formatUsdCompact(market.openInterestNotional)],
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
  elements.assetChartStatus.textContent = `LOADING UP TO ${MAX_CANDLE_BARS.toLocaleString()} ${interval.toUpperCase()} BARS…`;
  renderAssetBarReadout();
  try {
    state.assetChart = createAssetChart(elements.assetChart, (time) => {
      state.assetChartCursorTime = time;
      renderAssetBarReadout();
    }, (band) => liquidationView.inspect(band));
    liquidationView.setChart(asset,state.assetChart);
    const candles = await fetchCandles(asset, interval, MAX_CANDLE_BARS);
    if (token !== state.assetChartLoadToken || state.assetChartAsset !== asset || state.assetChartInterval !== interval) return;
    const liveCandles = state.assetCandles;
    state.assetCandles = liveCandles.reduce((history, candle) => mergeLiveCandle(history, candle), candles);
    state.assetChart.setData(state.assetCandles);
    renderAssetBarReadout();
    elements.assetChartStatus.textContent = "";
  } catch (error) {
    if (token !== state.assetChartLoadToken) return;
    liquidationView.setChart(null,null);
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
  liquidationView.setChart(null,null);
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
    ? `${data.stale ? "CACHED · " : ""}YAHOO FINANCE · ${date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "LATEST"}`
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
  if (source === "hyperliquid+yahoo") return "PRODUCT DESCRIPTION: HYPERLIQUID · MARKET IDENTITY: YAHOO FINANCE";
  if (source === "hyperliquid") return "PRODUCT DESCRIPTION: HYPERLIQUID";
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
  window.clearTimeout(state.assetNewsRetryTimer);
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
    state.assetNewsAsset = null;
    state.assetNewsRetryTimer = window.setTimeout(() => {
      const route = parseRoute(window.location.hash);
      if (route.view === "asset" && route.asset === asset && route.assetView === "news") loadAssetNews(asset);
    }, 15_000);
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
  const referenceDetail=!state.dotReferenceAsOf ? " · LOADING REFERENCES"
    : Date.now()-state.dotReferenceAsOf>60000 ? " · REFERENCES STALE — RETRYING"
    : state.dotReferenceMissing ? ` · ${state.dotReferenceMissing} REFERENCES RECOVERING` : "";
  const label=health.label+referenceDetail;
  if (elements.connectionLabel.textContent !== label) {
    elements.connectionLabel.textContent = label;
  }
  const tone=referenceDetail ? "warning" : health.tone;
  if (elements.connectionLabel.className !== tone) {
    elements.connectionLabel.className = tone;
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
    stream.send(JSON.stringify({ method: "subscribe", subscription: { type: "allDexsAssetCtxs" } }));
    if (state.assetCandleSubscription) sendCandleSubscription("subscribe", state.assetCandleSubscription);
    renderConnectionStatus();
  });

  stream.addEventListener("message", ({ data }) => {
    if (state.stream !== stream) return;
    const message = JSON.parse(data);
    if (message.channel === "candle") {
      state.streamMessageAt = Date.now();
      renderConnectionStatus();
      updateAssetCandle(message.data);
      return;
    }
    if (message.channel !== "allDexsAssetCtxs") return;
    state.streamMessageAt = Date.now();
    renderConnectionStatus();
    mapAllDexsAssetContexts(message.data, state.catalog).forEach((context, asset) => {
      if (state.markets.has(asset)) state.pendingMarketContexts.set(asset, context);
    });
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

function assetUniverseMarkets() {
  return hydrateAssetUniverse(state.catalog, state.markets);
}

function scheduleMarketRender() {
  if (state.marketRenderTimer) return;
  const delayMs = Math.max(0, 1_000 - (Date.now() - state.marketRenderedAt));
  state.marketRenderTimer = window.setTimeout(() => {
    state.marketRenderTimer = null;
    flushPendingMarketContexts();
    renderMarkets();
    renderAlertOptions();
    const route = parseRoute(window.location.hash);

    if (route.view === "asset") renderAssetDetail(route.asset, route.assetView, route.interval);
  }, delayMs);
}

function flushPendingMarketContexts(now = Date.now()) {
  if (!state.pendingMarketContexts.size) return;
  state.pendingMarketContexts.forEach((context, asset) => {
    const market = state.markets.get(asset);
    if (!market) return;
    const updatedMarket = applyLiveMarketContext(market, context);
    state.markets.set(asset, updatedMarket);
    recordLivePrice(asset, updatedMarket.markPrice, now);
  });
  state.pendingMarketContexts.clear();
  updateLastSync();
}

function recordLivePrice(asset, price, now = Date.now()) {
  state.priceHistories.set(asset, recordLivePricePoint(state.priceHistories.get(asset), price, now));
}

function formatDotDetail({ label, referencePrice, changePercent, referenceTime }) {
  if (referencePrice === null || changePercent === null) {
    return `${label.toUpperCase()} reference unavailable`;
  }
  return `${label.toUpperCase()} mark reference ${formatPrice(referencePrice)}${referenceTime ? ` · ${new Date(referenceTime).toISOString().replace("T"," ").replace(".000Z"," UTC")}` : ""} · ${formatPercent(changePercent)}`;
}

function displayAssetName(asset) {
  return displayAssetSymbol({ id: asset });
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

function formatVolatility(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
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
