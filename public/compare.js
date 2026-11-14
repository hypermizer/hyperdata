import { createPairMonitor } from "./pair-monitor.js?v=20261114-monitor1";
import { AssetPicker } from "./asset-picker.js?v=20261114-compare";
import { CANDLE_INTERVALS, mergeLiveCandle, normalizeCandle, postInfo } from "./lib/hyperliquid.js?v=20261110-marks";
import { chartRequest, chartWindows, fetchChartCandles } from "./lib/chart-grid.js?v=20261110-charts3";
import { anchoredComparisonModel, candleEnd, comparisonModel, comparisonPreferences, comparisonSeries, entryStartAnchor, intervalForStart, latestTradeQuote, marketStartAnchor, parseComparisonStart } from "./lib/comparison.js?v=20261114-monitor1";

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
  let monitor = null, pendingMonitorPair = null, retryHistory = false;
  let liveQuotes = [null, null], paintTimer = null, swapping = false;

  function key() { return `${prefs.assetA}|${prefs.assetB}|${prefs.interval}|${prefs.window}|${prefs.startTime}|${prefs.basis}|${prefs.entryA}|${prefs.entryB}`; }
  function cache() { try { localStorage.setItem(CACHE, JSON.stringify({ settings: prefs, dirty })); } catch { /* server persistence remains available */ } }
  function changed() {
    dirty = true; revision++; cache(); monitor?.settingsChanged(); $("save-status").textContent = "SAVING…";
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
      restored = true; initialized = true; cache(); controls(); selectSaved(); if (pendingMonitorPair) { const pair=pendingMonitorPair; pendingMonitorPair=null; applyMonitorPair(pair); }
      $("save-status").textContent = dirty ? "SAVING…" : "SAVED";
      if (active) start(); void save();
    } catch {
      initialized = true; controls(); selectSaved(); if(pendingMonitorPair){const pair=pendingMonitorPair;pendingMonitorPair=null;applyMonitorPair(pair);}
      $("save-status").textContent = "BROWSER SETTINGS · SERVER RETRYING";
      if (active) start(); setTimeout(restore, 15000);
    }
  }
  function controls() {
    if (prefs.startTime) prefs.interval = intervalForStart(prefs.interval, prefs.startTime);
    $("interval").value = CANDLE_INTERVALS.findIndex((item) => item.value === prefs.interval);
    $("interval-label").textContent = CANDLE_INTERVALS.find((item) => item.value === prefs.interval).label;
    const windows = chartWindows(prefs.interval);
    $("window").max = windows.length - 1; $("window").value = windows.findIndex((item) => item.seconds === prefs.window);
    $("window-label").textContent = prefs.startTime ? "FROM PAIR START" : windows.find((item) => item.seconds === prefs.window).label;
    $("window").disabled = prefs.startTime !== null;
    $("interval").min = prefs.startTime ? CANDLE_INTERVALS.findIndex((item) => item.value === intervalForStart("1m", prefs.startTime)) : 0;
    $("interval").setAttribute("aria-valuetext", $("interval-label").textContent);
    $("window").setAttribute("aria-valuetext", $("window-label").textContent);
    $("mode").value = prefs.mode;
    $("mode").disabled = prefs.startTime !== null;
    $("start-time").value = prefs.startTime ? new Date(prefs.startTime * 1000).toISOString().slice(0, prefs.basis === "entry" ? 19 : 16) : "";
    $("basis").value = prefs.basis;
    $("entry-a").value = prefs.entryA ?? ""; $("entry-b").value = prefs.entryB ?? "";
    $("start-clear").hidden = prefs.startTime === null;
    $("follow").checked = prefs.followNow;
    $("follow").parentElement.hidden = prefs.startTime === null;
    baselineControls();
    $("method").textContent = prefs.mode === "percent"
      ? "Lines use Hyperliquid trade-candle closes. Both returns start from the same completed candle, on one shared scale. Only matching timestamps are compared; missing observations are not filled. The latest candle may still be forming."
      : "Lines use Hyperliquid trade-candle closes. Asset A uses the left price axis; asset B uses the right price axis. These axes have independent scales. Use % return to compare performance. Only matching timestamps are plotted.";
    if (prefs.startTime) $("method").textContent = "Both legs begin at 0% at the selected UTC start: (latest price ÷ starting price − 1) × 100. Historical points use completed candle closes; the live endpoint updates from each leg's latest observed trade. Source ages are shown separately. Price returns exclude fees, funding and leverage.";
  }
  function baselineControls() {
    const entry = $("basis").value === "entry", hourly = $("basis").value === "hourly";
    $("entry-a-field").hidden = !entry; $("entry-b-field").hidden = !entry;
    $("start-time").step = entry ? "1" : hourly ? "3600" : "60";
    $("start-help").textContent = entry ? "Use your actual fill price for each leg. The time is UTC, including seconds; both returns begin at zero there." : hourly ? "Historical hourly baselines require a whole UTC hour (for example September 1 at 00:00 UTC). Both prices are the actual hourly candle closes ending at that exact hour. This uses Hyperliquid’s longer native history and never substitutes a nearby time." : "Market start prices use the shared one-minute candle ending at your chosen UTC minute. If that exact baseline is unavailable, enter your fill prices instead; no approximate price is substituted.";
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
      timeScale: { minBarSpacing: 0.01, timeVisible: true, secondsVisible: false, borderColor: "#34383d", shiftVisibleRangeOnNewBar: !prefs.startTime },
      crosshair: { mode: library.CrosshairMode.Normal },
    });
    series = ["#20d6a5", "#b799ff"].map((color, index) => chart.addSeries(library.LineSeries, {
      color, lineWidth: 2, priceScaleId: prefs.mode === "price" && index === 0 ? "left" : "right",
      priceFormat: prefs.mode === "percent"
        ? { type: "custom", minMove: 0.001, formatter: (value) => `${value.toFixed(2)}%` }
        : { type: "custom", minMove: 0.00000001, formatter: (value) => price.format(value) },
      title: index === 0 ? prefs.assetA : prefs.assetB,
    }));
    if (prefs.startTime) series[0].createPriceLine({ price: 0, color: "#929aa3", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "START" });
    chart.subscribeCrosshairMove(({ time }) => { cursor = typeof time === "number" ? time : null; readout(); });
    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (applyingRange || !renderedKey || Date.now() > gestureUntil || !range || typeof range.from !== "number" || typeof range.to !== "number") return;
      if (prefs.range?.from === range.from && prefs.range?.to === range.to) return;
      prefs.range = range; changed();
      if (prefs.startTime && prefs.followNow) { prefs.followNow = false; $("follow").checked = false; cache(); }
    });
  }
  function fit() {
    if (!chart || !model?.baseline) return;
    applyingRange = true;
    try { chart.timeScale().setVisibleRange(prefs.startTime && prefs.followNow ? { from: prefs.startTime, to: Math.max(prefs.startTime + 1, Date.now() / 1000) } : prefs.range ?? { from: prefs.startTime ?? Date.now() / 1000 - prefs.window, to: Date.now() / 1000 }); }
    finally { requestAnimationFrame(() => { applyingRange = false; const range = chart?.timeScale().getVisibleRange(); if(range){ $("chart").dataset.visibleFrom = range.from; $("chart").dataset.visibleTo = range.to; } }); }
  }
  function readout() {
    const rows = model?.rows.filter((row) => row.priceA !== undefined || prefs.startTime && row.priceB !== undefined) ?? [];
    const row = cursor === null ? rows.at(-1) : rows.find((row) => row.time === cursor);
    for (const [index, asset] of [prefs.assetA, prefs.assetB].entries()) {
      const element = $(index === 0 ? "legend-a" : "legend-b"); element.replaceChildren();
      const name = document.createElement("strong"); name.textContent = `${asset} · ${index === 0 ? "A" : "B"}${prefs.mode === "price" ? (index === 0 ? " · LEFT AXIS" : " · RIGHT AXIS") : ""}`;
      const value = document.createElement("span");
      const amount = row?.[index === 0 ? "priceA" : "priceB"], change = row?.[index === 0 ? "returnA" : "returnB"];
      value.textContent = amount !== undefined ? `${row.live ? "LAST" : row.anchor ? "START" : "CLOSE"} ${price.format(amount)} · ${percent(change)} FROM ${prefs.startTime ? "START" : "BASE"}` : "NO OBSERVATION";
      element.append(name, value);
    }
    $("readout").textContent = row ? prefs.startTime ? `${row.live ? "LIVE LAST-PRICE SNAPSHOT" : row.anchor ? "PAIR START · BOTH 0%" : "COMPLETED CANDLE CLOSE"} · ${utc(row.time)}` : `${cursor === null ? "LATEST SHARED" : "SELECTED"} CANDLE · ${utc(row.time)}${candleEnd(row.time, prefs.interval) > Date.now() / 1000 ? " · FORMING" : " · COMPLETED"}` : "Move over the chart to inspect both legs.";
  }
  function paint(reset = false) {
    if (!chart || !bars[0].length || !bars[1].length) return;
    model = prefs.startTime ? anchoredComparisonModel(bars[0], bars[1], { anchor: prefs.anchor, interval: prefs.interval, to: Date.now() / 1000, live: liveQuotes }) : comparisonModel(bars[0], bars[1], { interval: prefs.interval, from: loadedFrom, baselineFrom, to: Date.now() / 1000, baselineTime });
    if (!model.baseline) throw new Error("No shared completed candle in this history. Choose a wider history or another pair.");
    baselineTime = model.baseline.time;
    applyingRange = true;
    const data = comparisonSeries(model, prefs.mode); series.forEach((line, index) => line.setData(data[index]));
    $("chart").dataset.sharedPoints = model.rows.filter((row) => row.priceA !== undefined).length;
    $("chart").dataset.mode = prefs.mode;
    $("chart").dataset.baselineTime = model.baseline.time;
    $("chart").dataset.baselineA = model.baseline.priceA; $("chart").dataset.baselineB = model.baseline.priceB;
    $("baseline").textContent = `${prefs.startTime ? "FIXED START" : "BASE CANDLE"} · ${utc(baselineTime)} · ${prefs.assetA}: ${price.format(model.baseline.priceA)} · ${prefs.assetB}: ${price.format(model.baseline.priceB)}${prefs.startTime ? prefs.basis === "entry" ? " · YOUR FILL PRICES" : prefs.basis === "hourly" ? " · HOURLY CANDLE ENDING AT START" : " · ONE-MINUTE CANDLE ENDING AT START" : ""}${model.gaps ? ` · ${model.gaps} missing observations shown as gaps` : ""}`;
    if (reset || prefs.startTime && prefs.followNow) fit(); else requestAnimationFrame(() => { applyingRange = false; });
    readout(); status();
  }
  function status() {
    if (loading || !renderedKey) return;
    if (dataError) { $("status").textContent = `DATA REFRESH RETRYING · ${dataError}`; return; }
    const ages = lastReceived.map((time, index) => prefs.startTime ? liveQuotes[index]?.source === "trade" ? `last trade ${Math.max(0, Math.floor(Date.now() / 1000 - liveQuotes[index].time))}s ago` : "candle snapshot; waiting for live trades" : time ? `${Math.floor((Date.now() - time) / 1000)}s ago` : "candle snapshot only");
    $("status").textContent = `${streamConnected ? "STREAM CONNECTED" : "RECONNECTING"} · ${prefs.interval.toUpperCase()} HISTORY${prefs.startTime ? " + LIVE TRADES" : " CANDLES"} · A: ${ages[0]} · B: ${ages[1]}`;
  }
  async function pacedFetch(asset, settings, asOf, token, reference = false) {
    const projected = { ...settings, window: settings.startTime ? asOf / 1000 - settings.startTime : settings.window, ranges: settings.range ? { [asset]: settings.range } : {} };
    let scheduled = Date.now();
    try { scheduled = Math.max(scheduled, Math.min(scheduled + 30000, Number(sessionStorage.getItem("hyperdata.chart-history-next.v1")) || 0)); sessionStorage.setItem("hyperdata.chart-history-next.v1", String(scheduled + (reference ? 21 : chartRequest(projected, asOf, asset).weight) * 150)); } catch { /* bounded reads per load */ }
    if (scheduled > Date.now()) await new Promise((resolve) => setTimeout(resolve, scheduled - Date.now()));
    if (token !== generation || !active) return [];
    if (reference) {
      const duration = settings.basis === "hourly" ? 3600 : 60;
      const response = await postInfo({ type: "candleSnapshot", req: { coin: asset, interval: settings.basis === "hourly" ? "1h" : "1m", startTime: (settings.startTime - duration * 3) * 1000, endTime: settings.startTime * 1000 - 1 } });
      if (!Array.isArray(response)) throw new Error("Start-price history is unavailable.");
      const candles = response.map(normalizeCandle).filter(Boolean);
      if (candles.some(bar => bar.time === settings.startTime - duration)) return candles;
      const result = await client.rpc("request_comparison_history", { p_asset: asset, p_interval: duration === 3600 ? "1h" : "1m", p_start: (settings.startTime - duration * 3) * 1000, p_end: settings.startTime * 1000 - 1, p_retry: settings.retryHistory === true });
      if (result.error) throw Error(result.error.message);
      let job = result.data;
      for (let attempt = 0; attempt < 75 && ["pending", "running"].includes(job.state); attempt++) {
        if (token !== generation || !active) return [];
        $("status").textContent = `LOADING VERIFIED ARCHIVED START PRICE · ${asset}`;
        await new Promise(resolve => setTimeout(resolve, 1000));
        const state = await client.from("comparison_history_cache").select("state,data,error,source").eq("key", job.key).single();
        if (state.error) throw Error(state.error.message);
        job = { ...job, ...state.data };
      }
      if (job.state === "blocked") { const error = Error(job.error + " For dates such as September 1, you can explicitly choose HISTORICAL HOURLY CLOSE and a whole UTC hour, or enter your actual fills."); error.historyBlocked = true; throw error; }
      if (job.state !== "ready") { const error=Error(job.error ?? "Archived history is still loading. Retry shortly."); error.historyBlocked=job.state === "error"; throw error; }
      return job.data ?? [];
    }
    return await fetchChartCandles(asset, projected, fetch, asOf);
  }
  async function load({ reconnect = false } = {}) {
    if (!active || !initialized || !validPair() || loading) return;
    const token = ++generation, settings = { ...structuredClone(prefs), retryHistory }, asOf = Date.now(), loadKey = key();
    retryHistory = false;
    if (reconnect && baselineTime !== null && !settings.startTime) settings.range = { from: Math.min(settings.range?.from ?? baselineTime, baselineTime), to: asOf / 1000 };
    loading = true; retryAt = 0; $("retry").hidden = true; $("status").textContent = "LOADING MATCHED CANDLE HISTORY…";
    if (!reconnect) { bars = [[], []]; baselineTime = null; model = null; renderedKey = null; cursor = null; $("baseline").textContent = ""; $("readout").textContent = ""; $("legend-a").replaceChildren(); $("legend-b").replaceChildren(); $("chart").dataset.sharedPoints = "0"; }
    try {
      if (!chart) makeChart();
      if (settings.startTime && !settings.anchor) {
        if (settings.basis === "entry") settings.anchor = entryStartAnchor(settings);
        else {
          const references = await Promise.all([pacedFetch(settings.assetA, settings, asOf, token, true), pacedFetch(settings.assetB, settings, asOf, token, true)]);
          if (token !== generation || !active) return;
          settings.anchor = marketStartAnchor(references[0], references[1], settings);
        }
        prefs.anchor = settings.anchor; changed();
      }
      const snapshots = await Promise.all([pacedFetch(settings.assetA, settings, asOf, token), pacedFetch(settings.assetB, settings, asOf, token)]);
      if (token !== generation || !active || loadKey !== key()) return;
      bars = snapshots.map((history, index) => bars[index].reduce((all, bar) => mergeLiveCandle(all, bar, 4900), history));
      if (!bars[0].length || !bars[1].length) throw new Error("Candle history is unavailable for one of these assets. Try a different pair or interval.");
      if (settings.startTime) bars.forEach((history, index) => {
        if (liveQuotes[index]?.source === "trade") return;
        const last = history.at(-1), end = candleEnd(last.time, settings.interval);
        liveQuotes[index] = { price: last.close, time: Math.min(asOf / 1000, end), source: "snapshot" };
      });
      if (!reconnect) {
        baselineFrom = asOf / 1000 - settings.window;
        loadedFrom = settings.range ? Math.min(settings.range.from, baselineFrom) : baselineFrom;
      } else if (!settings.startTime && baselineTime !== null && !bars.every((history) => history.some((bar) => bar.time === baselineTime))) {
        baselineTime = null; baselineFrom = asOf / 1000 - settings.window; loadedFrom = baselineFrom;
      }
      dataError = null; renderedKey = loadKey; paint(true); refreshAt = Date.now() + 300000;
    } catch (error) {
      if (token !== generation || !active) return;
      dataError = error.message ?? "Comparison data unavailable";
      $("status").textContent = `${error.message ?? "Comparison unavailable"}${error.historyBlocked ? "" : " · RETRYING"}`;
      $("retry").hidden = false; retryAt = error.historyBlocked ? 0 : Date.now() + 30000;
      if (!reconnect) { renderedKey = null; model = null; series.forEach((line) => line.setData([])); }
    } finally { if (token === generation) loading = false; }
  }
  function closeStream() { const previous = socket; socket = null; streamConnected = false; previous?.close(); }
  function queuePaint() {
    if (paintTimer || loading || renderedKey !== key()) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      if (!active || loading || renderedKey !== key()) return;
      try { paint(); }
      catch { dataError = "Price history is resynchronizing"; retryAt ||= Date.now() + 30000; status(); }
    }, 100);
  }
  function connect() {
    if (!active || !initialized || !catalog || socket || Date.now() < reconnectAt || document.hidden || !validPair(prefs.assetA, prefs.assetB, false)) return;
    const ws = new WebSocket("wss://api.hyperliquid.xyz/ws"); socket = ws; lastFrame = Date.now();
    const timeout = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 10000);
    ws.onopen = () => {
      clearTimeout(timeout); if (socket !== ws) return;
      streamConnected = true; lastFrame = Date.now(); lastPing = 0;
      for (const asset of [prefs.assetA, prefs.assetB]) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "candle", coin: asset, interval: prefs.interval } }));
        if (prefs.startTime) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: asset } }));
      }
      if (connections++ > 0 && renderedKey && !loading) void load({ reconnect: true });
    };
    ws.onmessage = ({ data }) => {
      if (socket !== ws) return;
      try {
        const message = JSON.parse(data); lastFrame = Date.now(); backoff = 1000;
        if (prefs.startTime && message.channel === "trades" && Array.isArray(message.data)) {
          for (const trade of message.data) {
            const index = [prefs.assetA, prefs.assetB].indexOf(trade.coin);
            if (index < 0) continue;
            const quote = latestTradeQuote(liveQuotes[index], trade, trade.coin, prefs.startTime);
            if (quote === liveQuotes[index]) continue;
            liveQuotes[index] = quote; lastReceived[index] = Date.now();
          }
          queuePaint(); return;
        }
        if (message.channel !== "candle" || message.data?.i !== prefs.interval) return;
        const index = [prefs.assetA, prefs.assetB].indexOf(message.data.s), candle = normalizeCandle(message.data);
        if (index < 0 || !candle) return;
        bars[index] = mergeLiveCandle(bars[index], candle, 4900); lastReceived[index] = Date.now();
        queuePaint();
      } catch { /* an invalid or unpaired update cannot replace the shared baseline */ }
    };
    ws.onclose = () => { clearTimeout(timeout); if (socket !== ws) return; socket = null; streamConnected = false; reconnectAt = Date.now() + backoff; backoff = Math.min(30000, backoff * 2); status(); };
    ws.onerror = () => ws.close();
  }
  function start() {
    syncCatalog(); if (!active || !initialized || !catalog?.length || !validPair()) return;
    if (prefs.startTime && prefs.startTime > Date.now() / 1000) { $("error").textContent = "Choose a start time at or before now."; return; }
    generation++; loading = false; clearTimeout(paintTimer); paintTimer = null; closeStream(); disposeChart(); renderedKey = null; dataError = null; lastReceived = [0, 0]; liveQuotes = [null, null]; connections = 0;
    reconnectAt = 0; void load(); connect();
  }
  function applyPair() {
    const a = pickers[0].value, b = pickers[1].value;
    if (!validPair(a, b)) return;
    const entryA = prefs.startTime && prefs.basis === "entry" ? Number($("entry-a").value) : prefs.entryA;
    const entryB = prefs.startTime && prefs.basis === "entry" ? Number($("entry-b").value) : prefs.entryB;
    if (prefs.startTime && prefs.basis === "entry" && ![entryA, entryB].every((value) => Number.isFinite(value) && value > 0)) { $("error").textContent = "Enter the fill price for each selected asset before applying the new pair."; return; }
    prefs = comparisonPreferences({ ...prefs, assetA: a, assetB: b, entryA, entryB, anchor: a === prefs.assetA && b === prefs.assetB ? prefs.anchor : null, range: null }); changed(); controls(); start();
  }
  function applyStart() {
    const a = pickers[0].value, b = pickers[1].value, time = parseComparisonStart($("start-time").value);
    if (!validPair(a, b)) return;
    if (!time || time > Date.now() / 1000) { $("error").textContent = "Choose a valid UTC start at or before now."; return; }
    const basis = $("basis").value;
    if (basis === "hourly" && time % 3600 !== 0) { $("error").textContent = "Historical hourly closes require a whole UTC hour, such as September 1 at 00:00 UTC. Your chosen minute has not been changed."; return; }
    if (basis === "market" && time % 60 !== 0) { $("error").textContent = "For a market baseline, select an exact UTC minute."; return; }
    const next = comparisonPreferences({ ...prefs, assetA: a, assetB: b, startTime: time, basis, entryA: Number($("entry-a").value), entryB: Number($("entry-b").value), interval: intervalForStart("1m", time), mode: "percent", anchor: null, range: null, followNow: true });
    try { if (basis === "entry") next.anchor = entryStartAnchor(next); }
    catch (error) { $("error").textContent = error.message; return; }
    prefs = next; changed(); controls(); start();
  }
  $("form").addEventListener("submit", (event) => { event.preventDefault(); applyPair(); });
  $("swap").addEventListener("click", () => {
    const a = pickers[0].value, b = pickers[1].value; if (!validPair(a, b)) return;
    swapping = true; pickers[0].select(b); pickers[1].select(a); swapping = false;
    const anchor = prefs.anchor ? { ...prefs.anchor, assetA: b, assetB: a, priceA: prefs.anchor.priceB, priceB: prefs.anchor.priceA } : null;
    prefs = comparisonPreferences({ ...prefs, assetA: b, assetB: a, anchor, entryA: prefs.entryB, entryB: prefs.entryA, range: null });
    changed(); controls(); start();
  });
  for (const [index, picker] of pickers.entries()) picker.root.addEventListener("assetchange", ({ detail }) => {
    if (!swapping && detail.assetId && detail.assetId !== (index === 0 ? prefs.assetA : prefs.assetB)) $(index === 0 ? "entry-a" : "entry-b").value = "";
  });
  $("basis").addEventListener("change", baselineControls);
  $("start-apply").addEventListener("click", applyStart);
  $("start-clear").addEventListener("click", () => { prefs = comparisonPreferences({ ...prefs, startTime: null, anchor: null, range: null, followNow: true }); changed(); controls(); start(); });
  $("follow").addEventListener("change", () => { prefs.followNow = $("follow").checked; if (prefs.followNow) prefs.range = null; changed(); fit(); });
  $("interval").addEventListener("input", () => {
    prefs = comparisonPreferences({ ...prefs, interval: CANDLE_INTERVALS[Number($("interval").value)].value, range: null }); controls(); changed(); clearTimeout(controlTimer); controlTimer = setTimeout(start, 250);
  });
  $("window").addEventListener("input", () => { prefs.window = chartWindows(prefs.interval)[Number($("window").value)].seconds; prefs.range = null; controls(); changed(); clearTimeout(controlTimer); controlTimer = setTimeout(start, 250); });
  $("mode").addEventListener("change", () => {
    prefs.mode = $("mode").value; controls(); changed();
    if (model?.baseline && renderedKey === key()) { makeChart(); paint(true); } else start();
  });
  $("reset").addEventListener("click", () => { prefs.range = null; prefs.followNow = true; $("follow").checked = true; changed(); fit(); series.forEach((line) => line.priceScale().applyOptions({ autoScale: true })); });
  $("retry").addEventListener("click", () => { retryHistory=true; start(); });
  for (const event of ["pointerdown", "touchstart", "wheel"]) $("chart").addEventListener(event, () => {
    gestureUntil = Date.now() + 2000;
    if (prefs.startTime && prefs.followNow) { prefs.followNow = false; $("follow").checked = false; applyingRange = false; changed(); }
  }, { capture: true, passive: true });
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
  function applyMonitorPair(pair) {
    if(!initialized){pendingMonitorPair=pair;return;}
    if (prefs.assetA === pair.assetA && prefs.assetB === pair.assetB) return;
    prefs = comparisonPreferences({ ...prefs, assetA: pair.assetA, assetB: pair.assetB, anchor: null, range: null, basis: "market", entryA: null, entryB: null });
    changed(); controls(); selectSaved(); if (active) start();
  }
  monitor = createPairMonitor({ client, getCatalog, getSettings: () => structuredClone(prefs), onSelect: applyMonitorPair });
  controls(); void restore();
  return { setActive(value) {
    syncCatalog();
    if (active === value) { if (active && initialized && catalog?.length && !chart && !loading) start(); return; }
    active = value; monitor?.setActive(value);
    document.querySelector("main").classList.toggle("comparison-open", active);
    if (active) start();
    else { generation++; loading = false; clearTimeout(controlTimer); clearTimeout(paintTimer); paintTimer = null; closeStream(); disposeChart(); renderedKey = null; void save(); }
  } };
}
