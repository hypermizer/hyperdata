import { APP_CONFIG } from "./config.js";
import {
  TRIGGERED_LABEL,
  buildNewIssueUrl,
  parseAlertIssue,
} from "./lib/alerts.js";
import { fetchAllMarkets, fetchMarketsByDex } from "./lib/hyperliquid.js";

const state = {
  catalog: [],
  markets: new Map(),
  watchlist: loadWatchlist(),
  selectedAsset: null,
  priceHistory: new Map(),
  refreshing: false,
};

const elements = {
  alertAsset: document.querySelector("#alert-asset"),
  alertCount: document.querySelector("#alert-count"),
  alertForm: document.querySelector("#alert-form"),
  alertList: document.querySelector("#alert-list"),
  alertMessage: document.querySelector("#alert-message"),
  assetOptions: document.querySelector("#asset-options"),
  assetSearch: document.querySelector("#asset-search"),
  catalogCount: document.querySelector("#catalog-count"),
  connectionLabel: document.querySelector("#connection-label"),
  detailChange: document.querySelector("#detail-change"),
  detailContent: document.querySelector("#detail-content"),
  detailDex: document.querySelector("#detail-dex"),
  detailEmpty: document.querySelector("#detail-empty"),
  detailFunding: document.querySelector("#detail-funding"),
  detailLeverage: document.querySelector("#detail-leverage"),
  detailOi: document.querySelector("#detail-oi"),
  detailPrice: document.querySelector("#detail-price"),
  detailSymbol: document.querySelector("#detail-symbol"),
  detailVolume: document.querySelector("#detail-volume"),
  githubLink: document.querySelector("#github-link"),
  lastSync: document.querySelector("#last-sync"),
  marketList: document.querySelector("#market-list"),
  priceChart: document.querySelector("#price-chart"),
  refreshButton: document.querySelector("#refresh-button"),
  tickerTrack: document.querySelector("#ticker-track"),
  watchlistForm: document.querySelector("#watchlist-form"),
};

elements.githubLink.href = `https://github.com/${APP_CONFIG.repository}`;
wireEvents();
initialize();

async function initialize() {
  try {
    const markets = await fetchAllMarkets();
    state.catalog = markets.sort((a, b) => a.id.localeCompare(b.id));
    updateMarketMap(markets);
    renderCatalog();
    ensureValidWatchlist();
    selectAsset(state.watchlist[0]);
    setConnected(true);
    await loadAlerts();
  } catch (error) {
    setConnected(false, error.message);
    elements.marketList.innerHTML = `<p class="muted empty-state">Market data is temporarily unavailable. Try refreshing.</p>`;
  }
}

function wireEvents() {
  elements.refreshButton.addEventListener("click", refreshWatchlist);
  elements.watchlistForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = elements.assetSearch.value.trim().toLowerCase();
    const market = state.catalog.find(
      (item) => item.id.toLowerCase() === query || item.symbol.toLowerCase() === query,
    );
    if (!market) {
      elements.catalogCount.textContent = "Choose a market from the available catalog.";
      return;
    }
    if (!state.watchlist.includes(market.id)) state.watchlist.push(market.id);
    persistWatchlist();
    elements.assetSearch.value = "";
    selectAsset(market.id);
  });

  elements.marketList.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove]");
    if (removeButton) {
      event.stopPropagation();
      removeFromWatchlist(removeButton.dataset.remove);
      return;
    }
    const row = event.target.closest("[data-asset]");
    if (row) selectAsset(row.dataset.asset);
  });

  elements.alertForm.addEventListener("submit", (event) => {
    event.preventDefault();
    elements.alertMessage.textContent = "";
    const market = state.markets.get(elements.alertAsset.value);
    try {
      const target = Number(document.querySelector("#alert-target").value);
      const direction = document.querySelector("#alert-direction").value;
      if (market?.markPrice && direction === "above" && target <= market.markPrice) {
        throw new Error("An ‘above’ target must be higher than the current mark price.");
      }
      if (market?.markPrice && direction === "below" && target >= market.markPrice) {
        throw new Error("A ‘below’ target must be lower than the current mark price.");
      }
      const url = buildNewIssueUrl(APP_CONFIG.repository, {
        asset: market?.id ?? elements.alertAsset.value,
        dex: market?.dexId ?? "",
        direction,
        target,
      });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      elements.alertMessage.textContent = error.message;
    }
  });

  setInterval(refreshWatchlist, APP_CONFIG.refreshIntervalMs);
  setInterval(loadAlerts, APP_CONFIG.alertsRefreshIntervalMs);
  window.addEventListener("resize", renderDetail);
}

async function refreshWatchlist() {
  if (state.refreshing || !state.catalog.length) return;
  state.refreshing = true;
  elements.refreshButton.disabled = true;
  try {
    const dexIds = state.watchlist
      .map((id) => state.markets.get(id)?.dexId)
      .filter((dex) => dex !== undefined);
    const markets = await fetchMarketsByDex(dexIds);
    updateMarketMap(markets);
    render();
    setConnected(true);
  } catch (error) {
    setConnected(false, error.message);
  } finally {
    state.refreshing = false;
    elements.refreshButton.disabled = false;
  }
}

function updateMarketMap(markets) {
  markets.forEach((market) => {
    state.markets.set(market.id, market);
    if (state.watchlist.includes(market.id) && market.markPrice !== null) {
      const history = state.priceHistory.get(market.id) ?? [];
      history.push(market.markPrice);
      state.priceHistory.set(market.id, history.slice(-80));
    }
  });
  elements.lastSync.textContent = new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function ensureValidWatchlist() {
  state.watchlist = state.watchlist.filter((id) => state.markets.has(id));
  if (!state.watchlist.length) {
    state.watchlist = APP_CONFIG.defaultAssets.filter((id) => state.markets.has(id));
  }
  if (!state.watchlist.length && state.catalog[0]) state.watchlist = [state.catalog[0].id];
  persistWatchlist();
}

function render() {
  renderMarkets();
  renderTicker();
  renderDetail();
  renderAlertOptions();
}

function renderCatalog() {
  elements.assetOptions.innerHTML = state.catalog
    .map((market) => `<option value="${escapeHtml(market.id)}">${escapeHtml(market.dex)}</option>`)
    .join("");
  elements.catalogCount.textContent = `${state.catalog.length.toLocaleString()} live perpetual markets available.`;
}

function renderMarkets() {
  elements.marketList.innerHTML = state.watchlist
    .map((id) => {
      const market = state.markets.get(id);
      if (!market) return "";
      const directionClass = market.changePercent >= 0 ? "positive" : "negative";
      return `
        <button class="market-row ${id === state.selectedAsset ? "active" : ""}" type="button" data-asset="${escapeHtml(id)}">
          <span class="market-identity"><strong>${escapeHtml(market.symbol)}</strong><span>${escapeHtml(market.dex)}</span></span>
          <span class="market-price"><strong>${formatPrice(market.markPrice)}</strong><span>MARK</span></span>
          <span class="change-pill ${directionClass}">${formatPercent(market.changePercent)}</span>
          <span class="remove-market" role="button" tabindex="0" data-remove="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(market.symbol)}">×</span>
        </button>`;
    })
    .join("");
}

function renderTicker() {
  elements.tickerTrack.innerHTML = state.watchlist
    .map((id) => state.markets.get(id))
    .filter(Boolean)
    .map((market) => {
      const directionClass = market.changePercent >= 0 ? "positive" : "negative";
      return `<div class="ticker-item"><strong>${escapeHtml(market.symbol)}</strong><strong>${formatPrice(market.markPrice)}</strong><span>${escapeHtml(market.dex)}</span><span class="${directionClass}">${formatPercent(market.changePercent)}</span></div>`;
    })
    .join("");
}

function renderDetail() {
  const market = state.markets.get(state.selectedAsset);
  if (!market) return;
  elements.detailEmpty.classList.add("hidden");
  elements.detailContent.classList.remove("hidden");
  elements.detailDex.textContent = market.dex;
  elements.detailSymbol.textContent = market.symbol;
  elements.detailPrice.textContent = formatPrice(market.markPrice);
  elements.detailChange.textContent = `${formatPercent(market.changePercent)} / 24H`;
  elements.detailChange.className = market.changePercent >= 0 ? "positive" : "negative";
  elements.detailVolume.textContent = formatCompactUsd(market.volume24h);
  elements.detailOi.textContent = formatCompact(market.openInterest);
  elements.detailFunding.textContent = market.funding === null ? "—" : `${(market.funding * 100).toFixed(4)}%`;
  elements.detailLeverage.textContent = market.maxLeverage ? `${market.maxLeverage}×` : "—";
  drawChart(state.priceHistory.get(market.id) ?? [], market.changePercent >= 0);
}

function renderAlertOptions() {
  const currentValue = elements.alertAsset.value;
  elements.alertAsset.innerHTML = `<option value="">Choose an asset</option>${state.watchlist
    .map((id) => {
      const market = state.markets.get(id);
      return `<option value="${escapeHtml(id)}">${escapeHtml(market.symbol)} · ${formatPrice(market.markPrice)}</option>`;
    })
    .join("")}`;
  if (state.watchlist.includes(currentValue)) elements.alertAsset.value = currentValue;
  else if (state.selectedAsset) elements.alertAsset.value = state.selectedAsset;
}

async function loadAlerts() {
  try {
    const url = `https://api.github.com/repos/${APP_CONFIG.repository}/issues?state=open&labels=price-alert&per_page=100`;
    const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const issues = (await response.json())
      .filter((issue) => !issue.pull_request)
      .filter(
        (issue) =>
          !issue.labels.some((label) =>
            (typeof label === "string" ? label : label.name) === TRIGGERED_LABEL,
          ),
      )
      .map((issue) => ({ issue, alert: parseAlertIssue(issue.body) }))
      .filter((item) => item.alert);
    elements.alertCount.textContent = String(issues.length).padStart(2, "0");
    elements.alertList.innerHTML = issues.length
      ? issues.map(({ issue, alert }) => `<div class="alert-card"><div><strong>${escapeHtml(alert.asset)} ${alert.direction} ${formatPrice(alert.target)}</strong><span>ONE-TIME EMAIL ALERT</span></div><a href="${issue.html_url}" target="_blank" rel="noreferrer">Manage ↗</a></div>`).join("")
      : `<p class="muted">No active alerts. Create one above.</p>`;
  } catch {
    elements.alertCount.textContent = "—";
    elements.alertList.innerHTML = `<p class="muted">Active alerts will appear here once the GitHub repository is public.</p>`;
  }
}

function selectAsset(id) {
  if (!state.markets.has(id)) return;
  state.selectedAsset = id;
  render();
}

function removeFromWatchlist(id) {
  if (state.watchlist.length === 1) return;
  state.watchlist = state.watchlist.filter((asset) => asset !== id);
  if (state.selectedAsset === id) state.selectedAsset = state.watchlist[0];
  persistWatchlist();
  render();
}

function drawChart(values, isPositive) {
  const canvas = elements.priceChart;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 760;
  const height = canvas.clientHeight || 200;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);

  context.strokeStyle = "rgba(105, 113, 126, 0.13)";
  context.lineWidth = 1;
  for (let y = 35; y < height; y += 42) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  const points = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || Math.max(max * 0.001, 1);
  const padding = 24;
  const coordinates = points.map((value, index) => ({
    x: padding + (index / (points.length - 1)) * (width - padding * 2),
    y: padding + ((max - value) / range) * (height - padding * 2),
  }));

  const color = isPositive ? "#7ef2c4" : "#f57676";
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, isPositive ? "rgba(126,242,196,.18)" : "rgba(245,118,118,.16)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.beginPath();
  coordinates.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.lineTo(coordinates.at(-1).x, height);
  context.lineTo(coordinates[0].x, height);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  coordinates.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.stroke();
}

function setConnected(connected, detail = "") {
  const status = elements.connectionLabel.closest(".market-status");
  status.classList.toggle("offline", !connected);
  elements.connectionLabel.textContent = connected ? "Hyperliquid live" : `Connection issue${detail ? ` · ${detail}` : ""}`;
}

function loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem("hyperdata-watchlist"));
    return Array.isArray(saved) && saved.length ? saved : [...APP_CONFIG.defaultAssets];
  } catch {
    return [...APP_CONFIG.defaultAssets];
  }
}

function persistWatchlist() {
  localStorage.setItem("hyperdata-watchlist", JSON.stringify(state.watchlist));
}

function formatPrice(value) {
  if (value === null || value === undefined) return "—";
  const decimals = value >= 1000 ? 2 : value >= 1 ? 2 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: decimals }).format(value);
}

function formatPercent(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatCompact(value) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatCompactUsd(value) {
  if (value === null) return "—";
  return `$${formatCompact(value)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
