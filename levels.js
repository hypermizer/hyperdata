import { AssetPicker } from "./asset-picker.js?v=20260720-picker";
import { APP_CONFIG } from "./config.js?v=20260804-level-engine";
import { analyzeLevels } from "./lib/level-engine.js?v=20260804-level-engine";
import { assessLevelData, defaultLevelSession, mergeLevelCandle, splitLevelCandles } from "./lib/level-data.js?v=20260804-level-engine";
import { fetchCandles, MAX_CANDLE_BARS, normalizeCandle } from "./lib/hyperliquid.js?v=20260804-level-engine";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260720-assets";
import { createWatchlistClient } from "./lib/supabase.js?v=20260728-persistent-auth";

const elements = {
  form: document.querySelector("#levels-form"), pickerRoot: document.querySelector("#levels-asset-picker"),
  status: document.querySelector("#levels-status"), summary: document.querySelector("#levels-summary"),
  chart: document.querySelector("#levels-chart"), chartNote: document.querySelector("#levels-chart-note"),
  table: document.querySelector("#levels-table"), setups: document.querySelector("#levels-setups"),
  score: document.querySelector("#levels-score-detail"), refresh: document.querySelector("#levels-refresh"),
  downloadLevels: document.querySelector("#levels-download-levels"), downloadSetups: document.querySelector("#levels-download-setups"),
};

const picker = new AssetPicker(elements.pickerRoot, { details: "none" });
const client = createWatchlistClient(APP_CONFIG);
const state = { catalog: [], market: null, candles: [], result: null, selectedLevel: 0, loadToken: 0, stream: null, reconnectTimer: 0, connectTimer: 0, analyzedEnd: 0, user: null, preferenceTimer: 0 };
const historyCache = new Map();

initialize();

async function initialize() {
  bindEvents();
  try {
    const [, catalog] = await Promise.all([initializePreferences(), getMarketCatalog()]);
    state.catalog = catalog;
    picker.setCatalog(state.catalog);
    const preferred = await loadPreference();
    applyPreference(preferred);
    const initial = state.catalog.find(({ id }) => id === preferred?.asset)
      ?? state.catalog.find(({ id }) => id === "xyz:DRAM") ?? state.catalog[0];
    if (initial) picker.select(initial.id);
  } catch (error) {
    showError(error);
  }
}

function bindEvents() {
  elements.pickerRoot.addEventListener("assetchange", () => selectAsset(picker.value));
  elements.form.addEventListener("submit", (event) => { event.preventDefault(); loadHistory(true); });
  elements.form.addEventListener("change", ({ target }) => {
    if (["riskDollars", "sessionMode", "visibleLevels"].includes(target.name) && state.candles.length) analyzeAndRender();
    schedulePreferenceSave();
  });
  elements.form.addEventListener("input", ({ target }) => { if (target.name === "riskDollars") schedulePreferenceSave(); });
  elements.table.addEventListener("click", ({ target }) => {
    const row = target.closest("tr[data-level-index]");
    if (!row) return;
    state.selectedLevel = Number(row.dataset.levelIndex);
    renderLevels(); renderScore();
  });
  elements.downloadLevels.addEventListener("click", () => downloadCsv("levels", state.result?.levels ?? []));
  elements.downloadSetups.addEventListener("click", () => downloadCsv("setups", state.result?.setups ?? []));
  window.addEventListener("hashchange", syncStream);
  window.setInterval(() => {
    if (state.stream?.readyState === WebSocket.OPEN) state.stream.send(JSON.stringify({ method: "ping" }));
  }, 30_000);
}

async function initializePreferences() {
  if (!client) return;
  const { data } = await client.auth.getSession();
  state.user = data.session?.user?.email === APP_CONFIG.allowedEmail ? data.session.user : null;
  client.auth.onAuthStateChange((_event, session) => { state.user = session?.user?.email === APP_CONFIG.allowedEmail ? session.user : null; });
}

async function loadPreference() {
  if (!state.user) return null;
  const { data, error } = await client.from("level_tool_preferences").select("asset,risk_dollars,session_mode,visible_level_count").eq("user_id", state.user.id).maybeSingle();
  if (error && error.code !== "PGRST116" && error.code !== "42P01") throw error;
  return data;
}

function applyPreference(preference) {
  if (!preference) return;
  elements.form.elements.riskDollars.value = preference.risk_dollars ?? 500;
  elements.form.elements.sessionMode.value = preference.session_mode ?? "auto";
  elements.form.elements.visibleLevels.value = String(preference.visible_level_count ?? 10);
}

function schedulePreferenceSave() {
  window.clearTimeout(state.preferenceTimer);
  state.preferenceTimer = window.setTimeout(() => savePreference().catch(showError), 500);
}

async function savePreference() {
  if (!client || !state.user || !state.market) return;
  const settings = readSettings();
  await client.from("level_tool_preferences").upsert({
    user_id: state.user.id, asset: state.market.id, risk_dollars: settings.riskDollars,
    session_mode: elements.form.elements.sessionMode.value, visible_level_count: settings.visibleLevels,
  });
}

function selectAsset(assetId) {
  const market = state.catalog.find(({ id }) => id === assetId);
  if (!market || market.id === state.market?.id) return;
  state.market = market;
  state.candles = []; state.result = null; state.analyzedEnd = 0; state.selectedLevel = 0;
  schedulePreferenceSave();
  if (routeIsActive()) { connectStream(); loadHistory(); }
}

async function loadHistory(force = false) {
  if (!state.market) return;
  const token = ++state.loadToken;
  elements.refresh.disabled = true;
  elements.status.textContent = force ? "REFRESHING 5M HISTORY…" : "LOADING 5M HISTORY…";
  try {
    const cached = historyCache.get(state.market.id);
    const candles = !force && cached && Date.now() - cached.loadedAt < 120_000
      ? cached.candles
      : await fetchCandles(state.market.id, "5m", MAX_CANDLE_BARS);
    if (token !== state.loadToken) return;
    historyCache.set(state.market.id, { candles, loadedAt: Date.now() });
    state.candles = candles.map((candle) => ({ ...candle, time: candle.time * 1000 }));
    analyzeAndRender();
  } catch (error) {
    if (token === state.loadToken) showError(error);
  } finally {
    if (token === state.loadToken) elements.refresh.disabled = false;
  }
}

function readSettings() {
  const sessionChoice = elements.form.elements.sessionMode.value;
  return {
    riskDollars: Math.max(0, Number(elements.form.elements.riskDollars.value) || 0),
    sessionMode: sessionChoice === "auto" ? defaultLevelSession(state.market) : sessionChoice,
    visibleLevels: Number(elements.form.elements.visibleLevels.value) || 10,
  };
}

function analyzeAndRender() {
  try {
    const { completed, live } = splitLevelCandles(state.candles);
    const quality = assessLevelData(completed);
    if (!quality.usable) throw new Error(quality.message);
    const settings = readSettings();
    state.result = analyzeLevels(completed, { ticker: state.market.symbol, riskDollars: settings.riskDollars, sessionMode: settings.sessionMode });
    state.analyzedEnd = completed.at(-1).time;
    if (state.selectedLevel >= state.result.levels.length) state.selectedLevel = 0;
    renderAll(completed, live, quality, settings);
  } catch (error) {
    showError(error);
  }
}

function renderAll(completed, live, quality, settings) {
  const summary = state.result.summary;
  const ageMinutes = Math.max(0, Math.round(quality.ageMs / 60_000));
  elements.status.textContent = `READY · ${quality.barCount.toLocaleString()} COMPLETED BARS · ${quality.gaps} SESSION/TIME GAPS · LAST CLOSE ${ageMinutes}M AGO`;
  elements.summary.innerHTML = [
    ["LAST", price(summary.lastPrice)], ["REGIME", summary.regime.replaceAll("_", " ")], ["TREND", signed(summary.trendScore, 0)],
    ["15M ATR", price(summary.atr15m)], ["DAILY ATR", price(summary.dailyAtr)], ["VWAP", price(summary.sessionVwap)],
    ["SESSION", settings.sessionMode === "new_york_rth" ? "NY RTH" : "UTC 24H"], ["BARS USED", summary.sessionBarCount.toLocaleString()],
  ].map(metric).join("");
  elements.chartNote.textContent = `${state.market.symbol} · ${live ? "LIVE BAR SHOWN · " : ""}LEVELS AS OF ${formatTime(state.analyzedEnd)}`;
  renderChart([...completed, ...(live ? [live] : [])], state.result.levels.slice(0, settings.visibleLevels));
  renderLevels(); renderSetups(); renderScore();
}

function renderLevels() {
  const visible = readSettings().visibleLevels;
  const rows = (state.result?.levels ?? []).slice(0, visible);
  elements.table.innerHTML = table(["ROLE", "ZONE LOW", "CENTER", "ZONE HIGH", "SCORE", "TOUCHES", "DIST %", "SOURCES"], rows.map((level, index) => [
    `<span class="levels-role-${level.role}">${escapeHtml(level.role.replace("_", " ").toUpperCase())}</span>`, price(level.zoneLow), price(level.center), price(level.zoneHigh),
    fixed(level.score), level.touches, signed(level.distancePct), escapeHtml(level.sources.join(" · ")),
  ]), (index) => `data-level-index="${index}" class="${index === state.selectedLevel ? "is-selected" : ""}"`);
}

function renderSetups() {
  const rows = state.result?.setups ?? [];
  elements.setups.innerHTML = table(["SETUP", "ENTRY", "STOP", "TARGET 1", "R:R", "SHARES", "STATUS"], rows.map((setup) => [
    escapeHtml(setup.setup.replaceAll("_", " ").toUpperCase()), `${price(setup.entryZoneLow)}–${price(setup.entryZoneHigh)}`, price(setup.stop), price(setup.target1),
    fixed(setup.rr1), setup.sharesAtRiskBudget?.toLocaleString() ?? "—", escapeHtml(setup.status.replaceAll("_", " ").toUpperCase()),
  ]));
}

function renderScore() {
  const level = state.result?.levels?.[state.selectedLevel];
  if (!level) { elements.score.textContent = "NO LEVEL SELECTED"; return; }
  elements.score.innerHTML = [
    ["TOTAL", fixed(level.score)], ["SOURCE WEIGHT", signed(level.scoreComponents.source)], ["TOUCHES", signed(level.scoreComponents.touch)],
    ["VOLUME", signed(level.scoreComponents.volume)], ["DIVERSITY", signed(level.scoreComponents.diversity)], ["CLEANLINESS", signed(level.scoreComponents.cleanliness)],
    ["RECENCY", signed(level.scoreComponents.recency)], ["PROXIMITY", signed(level.scoreComponents.proximity)],
  ].map(metric).join("");
}

function renderChart(allBars, levels) {
  const bars = allBars.slice(-220);
  if (!bars.length) { elements.chart.replaceChildren(); return; }
  const width = 960; const height = 420; const margin = { top: 18, right: 74, bottom: 24, left: 10 };
  const lows = [...bars.map(({ low }) => low), ...levels.map(({ zoneLow }) => zoneLow)];
  const highs = [...bars.map(({ high }) => high), ...levels.map(({ zoneHigh }) => zoneHigh)];
  const low = Math.min(...lows); const high = Math.max(...highs); const span = Math.max(high - low, high * 0.001);
  const y = (value) => margin.top + (high - value) / span * (height - margin.top - margin.bottom);
  const plotWidth = width - margin.left - margin.right; const step = plotWidth / bars.length; const bodyWidth = Math.max(1, step * 0.58);
  const parts = [];
  for (let index = 0; index <= 4; index += 1) {
    const value = high - span * index / 4; const py = y(value);
    parts.push(`<line class="grid" x1="${margin.left}" x2="${width - margin.right}" y1="${py}" y2="${py}"/><text x="${width - margin.right + 7}" y="${py + 3}">${price(value)}</text>`);
  }
  levels.toReversed().forEach((level) => {
    const top = y(level.zoneHigh); const bottom = y(level.zoneLow);
    parts.push(`<rect class="zone-${level.role}" x="${margin.left}" y="${top}" width="${plotWidth}" height="${Math.max(2, bottom - top)}"/><text x="${margin.left + 5}" y="${Math.max(10, top - 3)}">${level.role.toUpperCase()} ${fixed(level.score)} · ${price(level.center)}</text>`);
  });
  bars.forEach((bar, index) => {
    const x = margin.left + (index + 0.5) * step; const className = bar.close >= bar.open ? "candle-up" : "candle-down";
    parts.push(`<line class="${className}" x1="${x}" x2="${x}" y1="${y(bar.high)}" y2="${y(bar.low)}"/><rect class="${className}" x="${x - bodyWidth / 2}" y="${Math.min(y(bar.open), y(bar.close))}" width="${bodyWidth}" height="${Math.max(1, Math.abs(y(bar.open) - y(bar.close)))}"/>`);
  });
  elements.chart.innerHTML = parts.join("");
}

function connectStream() {
  window.clearTimeout(state.reconnectTimer);
  window.clearTimeout(state.connectTimer);
  state.stream?.close();
  if (!state.market || !routeIsActive()) return;
  const assetId = state.market.id;
  const stream = new WebSocket(APP_CONFIG.websocketUrl);
  state.stream = stream;
  state.connectTimer = window.setTimeout(() => { if (stream.readyState === WebSocket.CONNECTING) stream.close(); }, 10_000);
  stream.addEventListener("open", () => {
    window.clearTimeout(state.connectTimer);
    stream.send(JSON.stringify({ method: "subscribe", subscription: { type: "candle", coin: assetId, interval: "5m" } }));
  });
  stream.addEventListener("message", ({ data }) => {
    if (state.stream !== stream) return;
    let message; try { message = JSON.parse(data); } catch { return; }
    if (message.channel !== "candle" || message.data?.s !== assetId || message.data?.i !== "5m") return;
    const candle = normalizeCandle(message.data);
    if (!candle) return;
    state.candles = mergeLevelCandle(state.candles, candle);
    const { completed, live } = splitLevelCandles(state.candles);
    if ((completed.at(-1)?.time ?? 0) > state.analyzedEnd) analyzeAndRender();
    else if (state.result) renderChart([...completed, ...(live ? [live] : [])], state.result.levels.slice(0, readSettings().visibleLevels));
  });
  stream.addEventListener("close", () => {
    window.clearTimeout(state.connectTimer);
    if (state.stream !== stream || !routeIsActive()) return;
    state.reconnectTimer = window.setTimeout(connectStream, 3_000);
  });
  stream.addEventListener("error", () => stream.close());
}

function syncStream() {
  if (routeIsActive()) {
    connectStream();
    if (!state.candles.length) loadHistory();
  } else {
    window.clearTimeout(state.reconnectTimer); window.clearTimeout(state.connectTimer);
    state.stream?.close(); state.stream = null;
  }
}

function routeIsActive() { return window.location.hash === "#/tools/levels"; }
function showError(error) { elements.status.textContent = `LEVEL ENGINE ERROR — ${String(error?.message ?? error).toUpperCase()}`; }
function metric([label, value]) { return `<span><small>${escapeHtml(String(label))}</small><strong>${escapeHtml(String(value))}</strong></span>`; }
function price(value) { return Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` : "—"; }
function fixed(value, digits = 2) { return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—"; }
function signed(value, digits = 2) { return Number.isFinite(Number(value)) ? `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(digits)}` : "—"; }
function formatTime(time) { return new Date(time).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).toUpperCase(); }
function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function table(headers, rows, attributes = () => "") {
  if (!rows.length) return '<p class="hint">NO RESULTS</p>';
  return `<table class="levels-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.map((cells, index) => `<tr ${attributes(index)}>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function downloadCsv(kind, rows) {
  if (!rows.length) return;
  const flattened = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Array.isArray(value) ? value.join("; ") : typeof value === "object" && value ? JSON.stringify(value) : value])));
  const headers = Object.keys(flattened[0]);
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers.map(quote).join(","), ...flattened.map((row) => headers.map((header) => quote(row[header])).join(","))].join("\n");
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `${state.market?.symbol ?? "asset"}_${kind}.csv`; link.click(); URL.revokeObjectURL(link.href);
}
