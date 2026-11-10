import { createAssetChart } from "./asset-chart.js?v=20261110-charts2";
import { CANDLE_INTERVALS, mergeLiveCandle, normalizeCandle } from "./lib/hyperliquid.js?v=20261110-marks";
import { chartRequest, chartWindows, fetchChartCandles, moveChart, normalizeChartPreferences, orderedChartAssets } from "./lib/chart-grid.js?v=20261110-charts2";
import { displayAssetSymbol } from "./lib/assets.js?v=20261028-assets-hardening";

const CACHE_KEY = "hyperdata.chart-grid.v1";
const money = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 });

export function createChartGrid({ client, getAssets, getMarket }) {
  const $ = (id) => document.getElementById("charts-" + id);
  const grid = $("grid"), status = $("save-status");
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}"); } catch { /* server restoration remains available */ }
  let preferences = normalizeChartPreferences(cached?.settings);
  let dirty = cached?.dirty === true, revision = 0, owner = null, ready = false, saving = false;
  let active = false, socket = null, reconnectAt = 0, reconnectBackoff = 1000, openedAt = 0, lastFrame = 0, lastPing = 0, connections = 0;
  let saveTimer = null, applyTimer = null, nextRequestAt = 0, requests = 0, dragged = null;
  try { nextRequestAt = Math.min(Date.now() + 30000, Number(sessionStorage.getItem("hyperdata.chart-history-next.v1")) || 0); } catch { /* memory pacing still applies */ }
  let subscribed = new Set(), restoringScroll = false;
  const cards = new Map();

  function cache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ settings: preferences, dirty })); }
    catch { status.textContent = "SERVER SAVE PENDING"; }
  }
  function changed() {
    dirty = true; revision++; cache();
    status.textContent = "SAVING…";
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 500);
  }
  async function save() {
    if (!dirty || saving || !ready || !owner || !client) return;
    saving = true;
    const version = revision;
    try {
      const { error } = await client.from("chart_grid_preferences").upsert({ user_id: owner, settings: structuredClone(preferences), updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) throw error;
      if (version === revision) { dirty = false; cache(); status.textContent = "SAVED"; }
    } catch { status.textContent = "SAVED IN BROWSER · SERVER RETRYING"; }
    finally {
      saving = false;
      if (dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 10000); }
    }
  }
  async function restore() {
    try {
      if (!client) throw new Error("Private session unavailable");
      const { data: session, error: sessionError } = await client.auth.getSession();
      if (sessionError || !session.session) throw sessionError ?? new Error("No session");
      owner = session.session.user.id;
      const { data, error } = await client.from("chart_grid_preferences").select("settings").eq("user_id", owner).maybeSingle();
      if (error) throw error;
      if (!dirty && data) { preferences = normalizeChartPreferences(data.settings); cache(); }
      ready = true;
      status.textContent = dirty ? "SAVING…" : "SAVED";
      controls(); if (active) applyShared();
      void save();
    } catch {
      status.textContent = "BROWSER LAYOUT · SERVER RETRYING";
      setTimeout(restore, 15000);
    }
  }
  function controls() {
    const windows = chartWindows(preferences.interval);
    $("interval").value = CANDLE_INTERVALS.findIndex((item) => item.value === preferences.interval);
    $("interval-label").textContent = CANDLE_INTERVALS.find((item) => item.value === preferences.interval).label;
    $("range").max = windows.length - 1;
    $("range").value = windows.findIndex((item) => item.seconds === preferences.window);
    $("range-label").textContent = windows.find((item) => item.seconds === preferences.window).label;
    for (const key of ["columns", "rows", "height"]) { $(key).value = preferences[key]; $(key + "-label").textContent = preferences[key] + (key === "height" ? " PX" : ""); }
    grid.style.setProperty("--chart-columns", preferences.columns);
    grid.style.setProperty("--chart-height", preferences.height + "px");
    grid.style.setProperty("--chart-rows", preferences.rows);
  }
  function resetRange(card) {
    if (!card.chart || !card.bars.length) return;
    card.applying = true;
    const range = preferences.ranges[card.asset] ?? { from: Date.now() / 1000 - preferences.window, to: Date.now() / 1000 };
    card.chart.setVisibleRange(range);
    // Chart resize/data callbacks run on an animation frame as well.
    requestAnimationFrame(() => { card.applying = false; });
  }
  function addCard(asset) {
    const node = document.createElement("article"); node.className = "chart-card"; node.dataset.chartAsset = asset;
    const header = document.createElement("header"); header.className = "chart-card-header"; header.draggable = true;
    const link = document.createElement("a"); link.href = "#/assets/" + encodeURIComponent(asset) + "/overview/" + preferences.interval;
    link.textContent = displayAssetSymbol(getMarket(asset) ?? { id: asset }); link.title = asset;
    const price = document.createElement("span"); price.className = "chart-card-price";
    const actions = document.createElement("span"); actions.className = "chart-card-actions";
    for (const [delta, symbol, label] of [[-1, "←", "Move earlier"], [1, "→", "Move later"]]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = symbol; button.setAttribute("aria-label", label + " " + asset);
      button.addEventListener("click", () => { const order = orderedChartAssets(getAssets(), preferences.order); const target = order[order.indexOf(asset) + delta]; if (target) reorder(asset, target); }); actions.append(button);
    }
    const chartElement = document.createElement("div"); chartElement.className = "chart-card-canvas";
    const message = document.createElement("p"); message.className = "chart-card-status"; message.textContent = "WAITING FOR CANDLES…";
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "chart-card-retry"; retry.textContent = "RETRY"; retry.hidden = true;
    header.append(link, price, actions); node.append(header, chartElement, message, retry); grid.append(node);
    const card = { asset, node, link, price, chartElement, message, retry, chart: null, bars: [], loading: false, applying: false, loadedKey: null, retryAt: 0, liveAt: 0, token: 0, gestureUntil: 0 };
    for (const event of ["pointerdown", "wheel", "touchstart"]) chartElement.addEventListener(event, () => { card.gestureUntil = Date.now() + 2000; }, { passive: true, capture: true });
    chartElement.addEventListener("pointermove", (event) => { if (event.buttons) card.gestureUntil = Date.now() + 2000; }, { passive: true });
    retry.addEventListener("click", () => { card.retryAt = 0; pump(); });
    header.addEventListener("dragstart", (event) => { dragged = asset; event.dataTransfer.setData("text/plain", asset); event.dataTransfer.effectAllowed = "move"; node.classList.add("dragging"); });
    header.addEventListener("dragend", () => { dragged = null; node.classList.remove("dragging"); grid.querySelectorAll(".drop-target").forEach((target) => target.classList.remove("drop-target")); });
    node.addEventListener("dragover", (event) => { if (dragged && dragged !== asset) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; node.classList.add("drop-target"); } });
    node.addEventListener("dragleave", (event) => { if (!node.contains(event.relatedTarget)) node.classList.remove("drop-target"); });
    node.addEventListener("drop", (event) => { event.preventDefault(); node.classList.remove("drop-target"); if (dragged) reorder(dragged, asset); });
    return card;
  }
  function reorder(source, target) {
    preferences.order = moveChart(orderedChartAssets(getAssets(), preferences.order), source, target);
    changed(); reconcile();
  }
  function reconcile() {
    if (!active) return;
    const assets = orderedChartAssets(getAssets(), preferences.order);
    $("count").textContent = `${assets.length} WATCHED`;
    for (const [asset, card] of cards) if (!assets.includes(asset)) { card.token++; card.chart?.destroy(); card.node.remove(); cards.delete(asset); }
    grid.querySelector(".charts-empty")?.remove();
    if (!assets.length) { const empty = document.createElement("p"); empty.className = "charts-empty"; empty.textContent = "Star assets in ASSETS to add them here."; grid.append(empty); }
    for (const [index, asset] of assets.entries()) {
      if (!cards.has(asset)) cards.set(asset, addCard(asset));
      const card = cards.get(asset); card.node.style.order = index;
      if (grid.children[index] !== card.node) {
        const focused = card.node.contains(document.activeElement) ? document.activeElement : null;
        grid.insertBefore(card.node, grid.children[index] ?? null); focused?.focus({ preventScroll: true });
      }
      if (!card.chart) {
        try { card.chart = createAssetChart(card.chartElement, undefined, undefined, { height: preferences.height, onRangeChange: (range) => {
          if (card.applying || !card.loadedKey || !active || Date.now() > card.gestureUntil) return;
          const current = preferences.ranges[asset];
          if (current && Math.abs(current.from - range.from) < 1 && Math.abs(current.to - range.to) < 1) return;
          preferences.ranges[asset] = range; changed();
        } }); } catch { card.message.textContent = "CHART LIBRARY UNAVAILABLE. RELOAD TO RETRY."; }
      }
      card.link.href = "#/assets/" + encodeURIComponent(asset) + "/overview/" + preferences.interval;
    }
    syncSubscriptions(); connect(); pump();
    restoringScroll = true;
    grid.scrollTop = preferences.scroll.top; grid.scrollLeft = preferences.scroll.left;
    requestAnimationFrame(() => { restoringScroll = false; });
  }
  function key() { return preferences.interval + ":" + preferences.window; }
  async function load(card) {
    const settings = structuredClone(preferences), loadKey = key(), token = ++card.token;
    card.loading = true; requests++; card.retry.hidden = true; card.message.textContent = "LOADING " + settings.interval.toUpperCase() + " CANDLES…";
    try {
      const bars = await fetchChartCandles(card.asset, settings);
      if (!active || token !== card.token || loadKey !== key() || !cards.has(card.asset)) return;
      card.bars = card.bars.reduce((all, candle) => mergeLiveCandle(all, candle, 4900), bars);
      if (!card.bars.length) throw new Error("No candles available for this asset and interval.");
      card.applying = true;
      card.chart?.setData(card.bars, false); card.loadedKey = loadKey; card.retryAt = 0; resetRange(card); updateLabel(card);
    } catch (error) {
      if (!active || token !== card.token || loadKey !== key()) return;
      card.message.textContent = (error.message ?? "History unavailable") + " · RETRYING"; card.retry.hidden = false; card.retryAt = Date.now() + 30000;
    } finally { card.loading = false; requests--; }
  }
  function pump() {
    if (!active || requests >= 2 || Date.now() < nextRequestAt || document.hidden) return;
    const card = [...cards.values()].filter((card) => card.chart && !card.loading && card.loadedKey !== key() && card.retryAt <= Date.now()).sort((a, b) => Number(a.node.style.order) - Number(b.node.style.order))[0];
    if (!card) return;
    // 400 weight/minute maximum, including across refreshes. Reserve most of the
    // public-IP allowance for market metadata and other active application work.
    nextRequestAt = Date.now() + chartRequest(preferences, Date.now(), card.asset).weight * 150;
    try { sessionStorage.setItem("hyperdata.chart-history-next.v1", String(nextRequestAt)); } catch { /* memory pacing still applies */ }
    void load(card);
  }
  function updateLabel(card) {
    if (!card.bars.length || card.loadedKey !== key()) return;
    card.price.textContent = money.format(card.bars.at(-1).close);
    card.message.textContent = `${preferences.interval.toUpperCase()} · ${card.bars.length} BARS · ${socket?.readyState === WebSocket.OPEN ? "STREAM CONNECTED" : "RECONNECTING"}`;
  }
  function send(method, asset) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method, subscription: { type: "candle", coin: asset, interval: preferences.interval } }));
  }
  function syncSubscriptions() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const wanted = new Set(cards.keys());
    for (const asset of subscribed) if (!wanted.has(asset)) send("unsubscribe", asset);
    for (const asset of wanted) if (!subscribed.has(asset)) send("subscribe", asset);
    subscribed = wanted;
  }
  function connect() {
    if (!active || !cards.size || socket || Date.now() < reconnectAt || document.hidden) return;
    const ws = new WebSocket("wss://api.hyperliquid.xyz/ws"); socket = ws; openedAt = Date.now();
    ws.onopen = () => {
      if (socket !== ws) return;
      lastFrame = Date.now(); lastPing = 0; subscribed = new Set();
      // Replay history after a reconnect/phone resume to recover missed candles.
      if (connections++ > 0) for (const card of cards.values()) { card.loadedKey = null; card.retryAt = 0; }
      syncSubscriptions(); pump();
    };
    ws.onmessage = ({ data }) => {
      if (socket !== ws) return;
      try {
        const message = JSON.parse(data); lastFrame = Date.now(); reconnectBackoff = 1000;
        if (message.channel !== "candle" || message.data?.i !== preferences.interval) return;
        const card = cards.get(message.data.s), candle = normalizeCandle(message.data);
        if (!card || !candle) return;
        const bars = mergeLiveCandle(card.bars, candle, 4900);
        if (bars === card.bars) return;
        card.bars = bars; card.liveAt = Date.now();
        if (card.loadedKey === key()) { card.applying = true; card.chart?.update(candle); requestAnimationFrame(() => { card.applying = false; }); updateLabel(card); }
      } catch { /* malformed frame cannot replace verified candles */ }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null; subscribed = new Set(); reconnectAt = Date.now() + reconnectBackoff;
      reconnectBackoff = Math.min(30000, reconnectBackoff * 2);
    };
    ws.onerror = () => ws.close();
  }
  function close() { const ws = socket; socket = null; subscribed = new Set(); ws?.close(); }
  function applyShared() {
    clearTimeout(applyTimer);
    close();
    for (const card of cards.values()) { card.token++; card.loadedKey = null; card.bars = []; card.retryAt = 0; card.applying = true; card.chart?.setData([], false); }
    reconcile();
  }
  $("interval").addEventListener("input", () => { preferences = normalizeChartPreferences({ ...preferences, interval: CANDLE_INTERVALS[Number($("interval").value)].value, ranges: {} }); controls(); changed(); clearTimeout(applyTimer); applyTimer = setTimeout(applyShared, 300); });
  $("range").addEventListener("input", () => { preferences.window = chartWindows(preferences.interval)[Number($("range").value)].seconds; preferences.ranges = {}; controls(); changed(); clearTimeout(applyTimer); applyTimer = setTimeout(applyShared, 300); });
  for (const name of ["columns", "rows", "height"]) $(name).addEventListener("input", () => { preferences[name] = Number($(name).value); controls(); changed(); });
  $("reset").addEventListener("click", () => { preferences.ranges = {}; changed(); for (const card of cards.values()) resetRange(card); });
  grid.addEventListener("scroll", () => {
    if (!active || restoringScroll) return;
    preferences.scroll = { top: grid.scrollTop, left: grid.scrollLeft }; changed();
  }, { passive: true });
  window.addEventListener("hyperdata:watchlist", () => { if (active) reconcile(); });
  window.addEventListener("online", () => { if (!ready) void restore(); else void save(); reconnectAt = 0; connect(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { close(); void save(); } else { reconnectAt = 0; connect(); pump(); } });
  setInterval(() => {
    if (!active || document.hidden) return;
    if (socket && Date.now() - Math.max(lastFrame, openedAt) > 60000) close();
    connect();
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastPing > 20000) { socket.send(JSON.stringify({ method: "ping" })); lastPing = Date.now(); }
    pump(); for (const card of cards.values()) updateLabel(card);
  }, 1000);
  controls(); void restore();
  return {
    setActive(value) {
      if (active === value) return;
      active = value;
      document.querySelector("main").classList.toggle("charts-open", active);
      if (active) reconcile();
      else { close(); void save(); for (const card of cards.values()) { card.token++; card.chart?.destroy(); } cards.clear(); grid.replaceChildren(); }
    },
  };
}
