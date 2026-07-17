import { APP_CONFIG } from "./config.js";
import {
  TRIGGERED_LABEL,
  buildNewIssueUrl,
  parseAlertIssue,
} from "./lib/alerts.js";
import {
  applyLiveMarketContext,
  fetchAllMarkets,
  fetchAverageDailyVolume,
} from "./lib/hyperliquid.js";

const state = {
  averageVolumes: new Map(),
  markets: new Map(),
  watchlist: [...APP_CONFIG.watchlist],
  stream: null,
  reconnectTimer: null,
};

const elements = {
  alertAsset: document.querySelector("#alert-asset"),
  alertCount: document.querySelector("#alert-count"),
  alertForm: document.querySelector("#alert-form"),
  alertList: document.querySelector("#alert-list"),
  alertMessage: document.querySelector("#alert-message"),
  connectionLabel: document.querySelector("#connection-label"),
  lastSync: document.querySelector("#last-sync"),
  marketList: document.querySelector("#market-list"),
  tabs: [...document.querySelectorAll("[data-tab]")],
  views: [...document.querySelectorAll("[role=tabpanel]")],
};

wireEvents();
initialize();

async function initialize() {
  try {
    const markets = await fetchAllMarkets();
    updateMarketMap(markets);
    ensureValidWatchlist();
    await refreshAverageVolumes();
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
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveView(tab.dataset.tab));
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
  setInterval(loadAlerts, APP_CONFIG.alertsRefreshIntervalMs);
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
}

function renderMarkets() {
  const rows = state.watchlist
    .map((id) => state.markets.get(id))
    .filter(Boolean)
    .map((market) => {
      const direction = market.changePercent >= 0 ? "positive" : "negative";
      return `<div class="market-row"><span>${escapeHtml(market.id)}</span><span class="metric">${formatPrice(market.markPrice)}</span><span class="metric ${direction}">${formatPercent(market.changePercent)}</span><span class="metric">${formatUsdCompact(market.volume24h)}</span><span class="metric">${formatUsdCompact(state.averageVolumes.get(market.id))}</span><span class="metric">${formatCompact(market.openInterest)}</span></div>`;
    })
    .join("");
  elements.marketList.innerHTML = `<div class="market-row header"><span>Asset</span><span class="metric">Mark price</span><span class="metric">24h</span><span class="metric">24h vol</span><span class="metric">Avg vol (30d)</span><span class="metric">OI</span></div>${rows}`;
}

function renderAlertOptions() {
  const selected = elements.alertAsset.value;
  elements.alertAsset.innerHTML = `<option value="">Choose asset</option>${state.watchlist
    .map((id) => {
      const market = state.markets.get(id);
      return `<option value="${escapeHtml(id)}">${escapeHtml(market.id)} (${formatPrice(market.markPrice)})</option>`;
    })
    .join("")}`;
  if (state.watchlist.includes(selected)) elements.alertAsset.value = selected;
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
    ? "Hyperliquid connected"
    : `Connection error${detail ? `: ${detail}` : ""}`;
  elements.connectionLabel.className = connected ? "positive" : "negative";
}

function connectMarketStream() {
  window.clearTimeout(state.reconnectTimer);
  state.stream?.close();
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
