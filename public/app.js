import { APP_CONFIG } from "./config.js?v=20260717-widths";
import {
  TRIGGERED_LABEL,
  buildNewIssueUrl,
  parseAlertIssue,
} from "./lib/alerts.js?v=20260717-widths";
import {
  applyLiveMarketContext,
  buildPriceChangeSignals,
  fetchAllMarkets,
  fetchAverageDailyVolume,
  fetchPriceHistory,
} from "./lib/hyperliquid.js?v=20260717-widths";
import { createWatchlistClient } from "./lib/supabase.js?v=20260717-widths";

const QUOTE_STALE_MS = 3_500;
const QUOTE_RECONNECT_COOLDOWN_MS = 5_000;

const state = {
  accountMessage: "",
  averageVolumes: new Map(),
  catalog: [],
  markets: new Map(),
  openDot: null,
  priceHistories: new Map(),
  quoteUpdatedAt: new Map(),
  supabase: createWatchlistClient(APP_CONFIG),
  stream: null,
  streamConnectedAt: 0,
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
  assetOptions: document.querySelector("#asset-options"),
  assetSearch: document.querySelector("#asset-search"),
  connectionLabel: document.querySelector("#connection-label"),
  lastSync: document.querySelector("#last-sync"),
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

wireEvents();
initialize();

async function initialize() {
  try {
    const markets = await fetchAllMarkets();
    state.catalog = markets.sort((a, b) => a.id.localeCompare(b.id));
    updateMarketMap(markets);
    await initializeWatchlistStorage();
    ensureValidWatchlist();
    await Promise.all([refreshAverageVolumes(), refreshPriceHistories()]);
    renderCatalog();
    render();
    setConnection(true);
    connectMarketStream();
    await loadAlerts();
  } catch (error) {
    setConnection(false, error.message);
    elements.marketList.textContent = "Market data unavailable.";
  }
}

function wireEvents() {
  elements.accountButton.addEventListener("click", handleAccountAction);
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

  elements.alertForm.addEventListener("submit", (event) => {
    event.preventDefault();
    elements.alertMessage.textContent = "";
    const market = state.markets.get(elements.alertAsset.value);
    const target = Number(document.querySelector("#alert-target").value);
    const direction = document.querySelector("#alert-direction").value;
    const delivery = document.querySelector("#alert-delivery").value;

    try {
      if (market?.markPrice && direction === "above" && target <= market.markPrice) {
        throw new Error("Above target must exceed current mark price.");
      }
      if (market?.markPrice && direction === "below" && target >= market.markPrice) {
        throw new Error("Below target must be below current mark price.");
      }
      window.open(
        buildNewIssueUrl(APP_CONFIG.repository, {
          asset: market?.id ?? elements.alertAsset.value,
          dex: market?.dexId ?? "",
          direction,
          target,
          delivery,
        }),
        "_blank",
        "noopener,noreferrer",
      );
    } catch (error) {
      elements.alertMessage.textContent = error.message;
    }
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
    await loadCloudWatchlist();
  } else state.watchlist = [...APP_CONFIG.initialWatchlist];
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
  elements.assetSearch.disabled = !state.user;
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
  const query = elements.assetSearch.value.trim().toLowerCase();
  const market = state.catalog.find(
    (item) => item.id.toLowerCase() === query || item.symbol.toLowerCase() === query,
  );
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
  elements.assetSearch.value = "";
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
}

function renderCatalog() {
  elements.assetOptions.innerHTML = state.catalog
    .map((market) => `<option value="${escapeHtml(displayAssetName(market.id))}"></option>`)
    .join("");
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
  try {
    const response = await fetch(
      `https://api.github.com/repos/${APP_CONFIG.repository}/issues?state=open&labels=price-alert&per_page=100`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const alerts = (await response.json())
      .filter((issue) => !issue.pull_request)
      .filter((issue) => !issue.labels.some((label) => (typeof label === "string" ? label : label.name) === TRIGGERED_LABEL))
      .map((issue) => ({ issue, alert: parseAlertIssue(issue.body) }))
      .filter((item) => item.alert);

    elements.alertCount.textContent = String(alerts.length);
    elements.alertList.innerHTML = alerts.length
      ? alerts.map(({ issue, alert }) => `<div class="alert-card"><span>${escapeHtml(alert.asset)} ${alert.direction} ${formatPrice(alert.target)} · ${alert.delivery === "sms" ? "text" : "email"}</span><a href="${issue.html_url}" target="_blank" rel="noreferrer">Manage</a></div>`).join("")
      : `<p class="hint">No active alerts.</p>`;
  } catch {
    elements.alertCount.textContent = "—";
    elements.alertList.innerHTML = `<p class="hint">Could not load alerts.</p>`;
  }
}

function setActiveView(viewName) {
  elements.tabs.forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === viewName));
  });
  elements.views.forEach((view) => {
    view.hidden = view.id !== `${viewName}-view`;
  });
}

function setConnection(connected, detail = "") {
  elements.connectionLabel.textContent = connected
    ? "HYPERLIQUID CONNECTED"
    : `CONNECTION ERROR${detail ? `: ${detail}` : ""}`;
  elements.connectionLabel.className = connected ? "positive" : "negative";
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
  state.streamConnectedAt = Date.now();
  const stream = new WebSocket(APP_CONFIG.websocketUrl);
  state.stream = stream;

  stream.addEventListener("open", () => {
    state.watchlist.forEach((coin) => {
      stream.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "activeAssetCtx", coin },
      }));
    });
    setConnection(true);
  });

  stream.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.channel !== "activeAssetCtx") return;
    const market = state.markets.get(message.data.coin);
    if (!market) return;
    state.markets.set(message.data.coin, applyLiveMarketContext(market, message.data.ctx));
    state.quoteUpdatedAt.set(message.data.coin, Date.now());
    updateLastSync();
    renderMarkets();
    renderAlertOptions();
  });

  stream.addEventListener("close", () => {
    if (state.stream !== stream) return;
    setConnection(false, "live stream disconnected");
    state.reconnectTimer = window.setTimeout(connectMarketStream, 3_000);
  });

  stream.addEventListener("error", () => stream.close());
}

function checkQuoteHealth() {
  if (!state.watchlist.length) return;
  const now = Date.now();
  const staleAssets = state.watchlist.filter((asset) => {
    const updatedAt = state.quoteUpdatedAt.get(asset);
    return !updatedAt || now - updatedAt > QUOTE_STALE_MS;
  });
  if (!staleAssets.length) return;

  setConnection(false, `stale quote: ${staleAssets.join(", ")}`);
  if (now - state.streamConnectedAt >= QUOTE_RECONNECT_COOLDOWN_MS) {
    connectMarketStream();
  }
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
