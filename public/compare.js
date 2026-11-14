import { AssetPicker } from "./asset-picker.js?v=20261114-compare";
import { CANDLE_INTERVALS, mergeLiveCandle, normalizeCandle } from "./lib/hyperliquid.js?v=20261110-marks";
import { chartRequest, chartWindows, fetchChartCandles } from "./lib/chart-grid.js?v=20261110-charts3";
import { candleEnd, comparisonModel, comparisonPreferences, comparisonSeries } from "./lib/comparison.js?v=20261114-compare";

const CACHE = "hyperdata.comparison.v1";
const price = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 });
const percent = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const utc = (time) => new Date(time * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");

export function createComparison({ client, getCatalog }) {
  const $ = (id) => document.getElementById("compare-" + id);
  const pickers = [new AssetPicker($("picker-a"), { details: "venue" }), new AssetPicker($("picker-b"), { details: "venue" })];
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(CACHE) ?? "{}"); } catch { /* restore from server */ }
  let prefs = comparisonPreferences(cached?.settings), dirty = cached?.dirty === true, revision = 0;
  let owner = null, restored = false, initialized = false, saving = false, saveTimer = null, catalog = null;
  let active = false, chart = null, series = [], bars = [[], []], model = null, cursor = null;
  let loading = false, generation = 0, loadedFrom = 0, baselineFrom = 0, baselineTime = null, renderedKey = null, retryAt = 0, refreshAt = 0;
  let socket = null, reconnectAt = 0, backoff = 1000, lastFrame = 0, lastPing = 0, streamConnected = false, connections = 0;
  let applyingRange = false, gestureUntil = 0, controlTimer = null, lastReceived = [0, 0], dataError = null;

  function key() { return `${prefs.assetA}|${prefs.assetB}|${prefs.interval}|${prefs.window}`; }
  function cache() { try { localStorage.setItem(CACHE, JSON.stringify({ settings: prefs, dirty })); } catch { /* server persistence remains available */ } }
  function changed() {
    dirty = true; revision++; cache(); $("save-status").textContent = "SAVING…";
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 500);
  }
  async function save() {
    if (!dirty || !restored || !owner || saving) return;
    saving = true; const version = revision;
    try {
      const { error } = await client.from("comparison_preferences").upsert({ user_id: owner, settings: structuredClone(prefs), updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) throw error;
      if (revision === version) { dirty = false; cache(); $("save-status").textContent = "SAVED"; }
    } catch { $("save-status").textContent = "SAVED IN BROWSER · SERVER RETRYING"; }
    finally { saving = false; if (dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 10000); } }
  }
  async function restore() {
    try {
      if (!client) throw new Error("Private session unavailable");
      const { data: session, error: sessionError } = await client.auth.getSession();
      if (sessionError || !session.session) throw sessionError ?? new Error("Private session unavailable");
      owner = session.session.user.id;
      const { data, error } = await client.from("comparison_preferences").select("settings").eq("user_id", owner).maybeSingle();
      if (error) throw error;
      if (!dirty && data) prefs = comparisonPreferences(data.settings);
      restored = true; initialized = true; cache(); controls(); selectSaved();
      $("save-status").textContent = dirty ? "SAVING…" : "SAVED";
      if (active) start(); void save();
    } catch {
      initialized = true; controls(); selectSaved();
      $("save-status").textContent = "BROWSER SETTINGS · SERVER RETRYING";
      if (active) start(); setTimeout(restore, 15000);
    }
  }
  function controls() {
    $("interval").value = CANDLE_INTERVALS.findIndex((item) => item.value === prefs.interval);
    $("interval-label").textContent = CANDLE_INTERVALS.find((item) => item.value === prefs.interval).label;
    const windows = chartWindows(prefs.interval);
    $("window").max = windows.length - 1; $("window").value = windows.findIndex((item) => item.seconds === prefs.window);
    $("window-label").textContent = windows.find((item) => item.seconds === prefs.window).label;
    $("interval").setAttribute("aria-valuetext", $("interval-label").textContent);
    $("window").setAttribute("aria-valuetext", $("window-label").textContent);
    $("mode").value = prefs.mode;
    $("method").textContent = prefs.mode === "percent"
      ? "Lines use Hyperliquid trade-candle closes. Both returns start from the same completed candle, on one shared scale. Only matching timestamps are compared; missing observations are not filled. The latest candle may still be forming."
      : "Lines use Hyperliquid trade-candle closes. Asset A uses the left price axis; asset B uses the right price axis. These axes have independent scales. Use % return to compare performance. Only matching timestamps are plotted.";
  }
  function syncCatalog() {
    const next = getCatalog();
    if (next === catalog || !next.length) return;
    catalog = next; pickers.forEach((picker) => picker.setCatalog(catalog)); selectSaved();
  }
  function selectSaved() {
    if (!catalog) return;
    pickers[0].select(prefs.assetA); pickers[1].select(prefs.assetB);
  }
  function validPair(a = prefs.assetA, b = prefs.assetB, report = true) {
    if (!catalog?.some((asset) => asset.id === a) || !catalog.some((asset) => asset.id === b)) {
      if (report) $("error").textContent = "Choose two available assets, including their exchange venues."; return false;
    }
    if (a === b) { if (report) $("error").textContent = "Choose two different assets to compare."; return false; }
    if (report) $("error").textContent = "";
    return true;
  }
  function disposeChart() { chart?.remove(); chart = null; series = []; $("chart").replaceChildren(); }
  function makeChart() {
    disposeChart();
    const library = window.LightweightCharts;
    if (!library?.LineSeries) throw new Error("Chart library unavailable. Reload to retry.");
    chart = library.createChart($("chart"), {
      autoSize: true, height: 520,
      layout: { background: { type: "solid", color: "#101214" }, textColor: "#a8afb7", attributionLogo: true },
      grid: { vertLines: { color: "rgba(236,239,241,.06)" }, horzLines: { color: "rgba(236,239,241,.06)" } },
      leftPriceScale: { visible: prefs.mode === "price", borderColor: "#34383d", textColor: "#20d6a5" },
      rightPriceScale: { visible: true, borderColor: "#34383d", textColor: prefs.mode === "price" ? "#b799ff" : "#a8afb7" },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#34383d", shiftVisibleRangeOnNewBar: true },
      crosshair: { mode: library.CrosshairMode.Normal },
    });
    series = ["#20d6a5", "#b799ff"].map((color, index) => chart.addSeries(library.LineSeries, {
      color, lineWidth: 2, priceScaleId: prefs.mode === "price" && index === 0 ? "left" : "right",
      priceFormat: prefs.mode === "percent"
        ? { type: "custom", minMove: 0.001, formatter: (value) => `${value.toFixed(2)}%` }
        : { type: "custom", minMove: 0.00000001, formatter: (value) => price.format(value) },
      title: index === 0 ? prefs.assetA : prefs.assetB,
    }));
    chart.subscribeCrosshairMove(({ time }) => { cursor = typeof time === "number" ? time : null; readout(); });
    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (applyingRange || !renderedKey || Date.now() > gestureUntil || !range || typeof range.from !== "number" || typeof range.to !== "number") return;
      if (prefs.range?.from === range.from && prefs.range?.to === range.to) return;
      prefs.range = range; changed();
    });
  }
  function fit() {
    if (!chart || !model?.baseline) return;
    applyingRange = true;
    try { chart.timeScale().setVisibleRange(prefs.range ?? { from: Date.now() / 1000 - prefs.window, to: Date.now() / 1000 }); }
    finally { requestAnimationFrame(() => { applyingRange = false; }); }
  }
  function readout() {
    const rows = model?.rows.filter((row) => row.priceA !== undefined) ?? [];
    const row = cursor === null ? rows.at(-1) : rows.find((row) => row.time === cursor);
    for (const [index, asset] of [prefs.assetA, prefs.assetB].entries()) {
      const element = $(index === 0 ? "legend-a" : "legend-b"); element.replaceChildren();
      const name = document.createElement("strong"); name.textContent = `${asset} · ${index === 0 ? "A" : "B"}${prefs.mode === "price" ? (index === 0 ? " · LEFT AXIS" : " · RIGHT AXIS") : ""}`;
      const value = document.createElement("span");
      value.textContent = row ? `CLOSE ${price.format(row[index === 0 ? "priceA" : "priceB"])} · ${percent(row[index === 0 ? "returnA" : "returnB"])} FROM BASE` : "NO MATCHING CANDLE";
      element.append(name, value);
    }
    $("readout").textContent = row ? `${cursor === null ? "LATEST SHARED" : "SELECTED"} CANDLE · ${utc(row.time)}${candleEnd(row.time, prefs.interval) > Date.now() / 1000 ? " · FORMING" : " · COMPLETED"}` : "Move over a shared candle to inspect both assets at the same timestamp.";
  }
  function paint(reset = false) {
    if (!chart || !bars[0].length || !bars[1].length) return;
    model = comparisonModel(bars[0], bars[1], { interval: prefs.interval, from: loadedFrom, baselineFrom, to: Date.now() / 1000, baselineTime });
    if (!model.baseline) throw new Error("No shared completed candle in this history. Choose a wider history or another pair.");
    baselineTime = model.baseline.time;
    applyingRange = true;
    const data = comparisonSeries(model, prefs.mode); series.forEach((line, index) => line.setData(data[index]));
    $("chart").dataset.sharedPoints = model.rows.filter((row) => row.priceA !== undefined).length;
    $("chart").dataset.mode = prefs.mode;
    $("baseline").textContent = `BASE CANDLE · ${utc(baselineTime)} · ${prefs.assetA}: ${price.format(model.baseline.priceA)} · ${prefs.assetB}: ${price.format(model.baseline.priceB)}${model.gaps ? ` · ${model.gaps} unmatched observations shown as gaps` : ""}`;
    if (reset) fit(); else requestAnimationFrame(() => { applyingRange = false; });
    readout(); status();
  }
  function status() {
    if (loading || !renderedKey) return;
    if (dataError) { $("status").textContent = `DATA REFRESH RETRYING · ${dataError}`; return; }
    const ages = lastReceived.map((time) => time ? `${Math.floor((Date.now() - time) / 1000)}s ago` : "snapshot only");
    $("status").textContent = `${streamConnected ? "STREAM CONNECTED" : "RECONNECTING"} · ${prefs.interval.toUpperCase()} CANDLES · A update: ${ages[0]} · B update: ${ages[1]}`;
  }
  async function pacedFetch(asset, settings, asOf, token) {
    const projected = { ...settings, ranges: settings.range ? { [asset]: settings.range } : {} };
    let scheduled = Date.now();
    try { scheduled = Math.max(scheduled, Math.min(scheduled + 30000, Number(sessionStorage.getItem("hyperdata.chart-history-next.v1")) || 0)); sessionStorage.setItem("hyperdata.chart-history-next.v1", String(scheduled + chartRequest(projected, asOf, asset).weight * 150)); } catch { /* at most two bounded requests per load */ }
    if (scheduled > Date.now()) await new Promise((resolve) => setTimeout(resolve, scheduled - Date.now()));
    if (token !== generation || !active) return [];
    return await fetchChartCandles(asset, projected, fetch, asOf);
  }
  async function load({ reconnect = false } = {}) {
    if (!active || !initialized || !validPair() || loading) return;
    const token = ++generation, settings = structuredClone(prefs), asOf = Date.now(), loadKey = key();
    if (reconnect && baselineTime !== null) settings.range = { from: Math.min(settings.range?.from ?? baselineTime, baselineTime), to: asOf / 1000 };
    loading = true; retryAt = 0; $("retry").hidden = true; $("status").textContent = "LOADING MATCHED CANDLE HISTORY…";
    if (!reconnect) { bars = [[], []]; baselineTime = null; model = null; renderedKey = null; cursor = null; $("baseline").textContent = ""; $("readout").textContent = ""; $("legend-a").replaceChildren(); $("legend-b").replaceChildren(); $("chart").dataset.sharedPoints = "0"; }
    try {
      if (!chart) makeChart();
      const snapshots = await Promise.all([pacedFetch(settings.assetA, settings, asOf, token), pacedFetch(settings.assetB, settings, asOf, token)]);
      if (token !== generation || !active || loadKey !== key()) return;
      bars = snapshots.map((history, index) => bars[index].reduce((all, bar) => mergeLiveCandle(all, bar, 4900), history));
      if (!bars[0].length || !bars[1].length) throw new Error("Candle history is unavailable for one of these assets. Try a different pair or interval.");
      if (!reconnect) {
        baselineFrom = asOf / 1000 - settings.window;
        loadedFrom = settings.range ? Math.min(settings.range.from, baselineFrom) : baselineFrom;
      } else if (baselineTime !== null && !bars.every((history) => history.some((bar) => bar.time === baselineTime))) {
        baselineTime = null; baselineFrom = asOf / 1000 - settings.window; loadedFrom = baselineFrom;
      }
      dataError = null; renderedKey = loadKey; paint(true); refreshAt = Date.now() + 300000;
    } catch (error) {
      if (token !== generation || !active) return;
      dataError = error.message ?? "Comparison data unavailable";
      $("status").textContent = `${error.message ?? "Comparison unavailable"} · RETRYING`;
      $("retry").hidden = false; retryAt = Date.now() + 30000;
      if (!reconnect) { renderedKey = null; model = null; series.forEach((line) => line.setData([])); }
    } finally { if (token === generation) loading = false; }
  }
  function closeStream() { const previous = socket; socket = null; streamConnected = false; previous?.close(); }
  function connect() {
    if (!active || !initialized || !catalog || socket || Date.now() < reconnectAt || document.hidden || !validPair(prefs.assetA, prefs.assetB, false)) return;
    const ws = new WebSocket("wss://api.hyperliquid.xyz/ws"); socket = ws; lastFrame = Date.now();
    const timeout = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 10000);
    ws.onopen = () => {
      clearTimeout(timeout); if (socket !== ws) return;
      streamConnected = true; lastFrame = Date.now(); lastPing = 0;
      for (const asset of [prefs.assetA, prefs.assetB]) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "candle", coin: asset, interval: prefs.interval } }));
      if (connections++ > 0 && renderedKey && !loading) void load({ reconnect: true });
    };
    ws.onmessage = ({ data }) => {
      if (socket !== ws) return;
      try {
        const message = JSON.parse(data); lastFrame = Date.now(); backoff = 1000;
        if (message.channel !== "candle" || message.data?.i !== prefs.interval) return;
        const index = [prefs.assetA, prefs.assetB].indexOf(message.data.s), candle = normalizeCandle(message.data);
        if (index < 0 || !candle) return;
        bars[index] = mergeLiveCandle(bars[index], candle, 4900); lastReceived[index] = Date.now();
        if (!loading && renderedKey === key()) {
          try { paint(); }
          catch { dataError = "Shared candles are resynchronizing"; retryAt ||= Date.now() + 30000; status(); }
        }
      } catch { /* an invalid or unpaired update cannot replace the shared baseline */ }
    };
    ws.onclose = () => { clearTimeout(timeout); if (socket !== ws) return; socket = null; streamConnected = false; reconnectAt = Date.now() + backoff; backoff = Math.min(30000, backoff * 2); status(); };
    ws.onerror = () => ws.close();
  }
  function start() {
    syncCatalog(); if (!active || !initialized || !catalog?.length || !validPair()) return;
    generation++; loading = false; closeStream(); disposeChart(); renderedKey = null; dataError = null; lastReceived = [0, 0]; connections = 0;
    reconnectAt = 0; void load(); connect();
  }
  function applyPair() {
    const a = pickers[0].value, b = pickers[1].value;
    if (!validPair(a, b)) return;
    prefs = comparisonPreferences({ ...prefs, assetA: a, assetB: b, range: null }); changed(); controls(); start();
  }
  $("form").addEventListener("submit", (event) => { event.preventDefault(); applyPair(); });
  $("swap").addEventListener("click", () => { const a = pickers[0].value, b = pickers[1].value; if (!validPair(a, b)) return; pickers[0].select(b); pickers[1].select(a); applyPair(); });
  $("interval").addEventListener("input", () => {
    prefs = comparisonPreferences({ ...prefs, interval: CANDLE_INTERVALS[Number($("interval").value)].value, range: null }); controls(); changed(); clearTimeout(controlTimer); controlTimer = setTimeout(start, 250);
  });
  $("window").addEventListener("input", () => { prefs.window = chartWindows(prefs.interval)[Number($("window").value)].seconds; prefs.range = null; controls(); changed(); clearTimeout(controlTimer); controlTimer = setTimeout(start, 250); });
  $("mode").addEventListener("change", () => {
    prefs.mode = $("mode").value; controls(); changed();
    if (model?.baseline && renderedKey === key()) { makeChart(); paint(true); } else start();
  });
  $("reset").addEventListener("click", () => { prefs.range = null; changed(); fit(); series.forEach((line) => line.priceScale().applyOptions({ autoScale: true })); });
  $("retry").addEventListener("click", start);
  for (const event of ["pointerdown", "touchstart", "wheel"]) $("chart").addEventListener(event, () => { gestureUntil = Date.now() + 2000; }, { capture: true, passive: true });
  $("chart").addEventListener("pointermove", (event) => { if (event.buttons) gestureUntil = Date.now() + 2000; }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { closeStream(); void save(); }
    else if (active) { reconnectAt = 0; connect(); if (renderedKey && !loading) void load({ reconnect: true }); }
  });
  setInterval(() => {
    if (!active || document.hidden || !initialized) return;
    if (socket && Date.now() - lastFrame > 60000) closeStream(); connect();
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastPing > 20000) { socket.send(JSON.stringify({ method: "ping" })); lastPing = Date.now(); }
    if (!loading && (retryAt && Date.now() >= retryAt || renderedKey && Date.now() >= refreshAt)) void load({ reconnect: Boolean(renderedKey) });
    status(); if (model) readout();
  }, 1000);
  controls(); void restore();
  return { setActive(value) {
    syncCatalog();
    if (active === value) { if (active && initialized && catalog?.length && !chart && !loading) start(); return; }
    active = value;
    document.querySelector("main").classList.toggle("comparison-open", active);
    if (active) start();
    else { generation++; loading = false; clearTimeout(controlTimer); closeStream(); disposeChart(); renderedKey = null; void save(); }
  } };
}
