import { APP_CONFIG } from "./config.js?v=20260718-listener";
import { AssetPicker } from "./asset-picker.js?v=20260721-audio";
import { displayAssetSymbol } from "./lib/assets.js?v=20260720-stream";
import { audioStreamUrl, listenerAssetCatalog } from "./lib/audio.js?v=20260721-audio";
import { fetchMarketsForDex } from "./lib/hyperliquid.js?v=20260720-assets";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260720-assets";
import { createWatchlistClient } from "./lib/supabase.js?v=20260721-strats";

const INTERVAL_MS = 10_000;
const MARKET_TIMEOUT_MS = 8_000;
const STREAM_URL = "https://32.195.109.193/priceaudio-audio/live.mp3";
const STORAGE_KEY = "hyperdata.audio.assets";
const client = createWatchlistClient(APP_CONFIG);
const elements = {
  buttonDetail: document.querySelector("#audio-button-detail"),
  buttonLabel: document.querySelector("#audio-button-label"),
  console: document.querySelector(".audio-console"),
  knownAssets: document.querySelector("#audio-known-assets"),
  meta: document.querySelector("#audio-meta"),
  price: document.querySelector("#audio-price"),
  searchForm: document.querySelector("#audio-search-form"),
  state: document.querySelector("#audio-state"),
  status: document.querySelector("#audio-status"),
  stream: document.querySelector("#audio-stream"),
  symbol: document.querySelector("#audio-symbol"),
  toggle: document.querySelector("#audio-toggle"),
};
const picker = new AssetPicker(document.querySelector("#audio-asset-picker"), { details: "none" });
const state = {
  catalog: [],
  latestMarket: null,
  nextAnnouncementAt: 0,
  playing: false,
  refreshToken: 0,
  remembered: readRememberedAssets(),
  selectedId: "",
  session: null,
  syncAvailable: false,
  timer: null,
  countdownTimer: null,
  watchlist: [...APP_CONFIG.initialWatchlist],
};

wire();
initialize().catch((error) => setStatus(error.message ?? "AUDIO UNAVAILABLE"));

function wire() {
  elements.knownAssets.addEventListener("change", selectKnownAsset);
  elements.searchForm.addEventListener("submit", selectSearchedAsset);
  elements.toggle.addEventListener("click", () => state.playing ? stopAudio() : startAudio());
  elements.stream.addEventListener("playing", () => setPlaying(true));
  elements.stream.addEventListener("pause", () => { if (state.playing) setPlaying(false); });
  elements.stream.addEventListener("waiting", () => { if (state.playing) setStatus("BUFFERING LIVE AUDIO"); });
  elements.stream.addEventListener("error", () => { setPlaying(false); setStatus("LIVE AUDIO IS TEMPORARILY UNAVAILABLE"); });
  window.addEventListener("hyperdata:watchlist", ({ detail }) => {
    state.watchlist = Array.isArray(detail?.assets) ? detail.assets : state.watchlist;
    renderAssetOptions();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.playing) refreshPrice(); });
}

async function initialize() {
  state.catalog = await getMarketCatalog();
  picker.setCatalog(state.catalog);
  if (client) {
    try {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      await setSession(data.session);
      client.auth.onAuthStateChange((_event, session) => window.setTimeout(() => {
        setSession(session).catch((authError) => setStatus(`SYNC UNAVAILABLE · ${authError.message}`));
      }, 0));
    } catch (error) {
      state.session = null;
      state.syncAvailable = false;
      setStatus(`SYNC UNAVAILABLE · ${error.message}`);
    }
  }
  renderAssetOptions();
  const initial = listenerAssets()[0]?.id ?? state.catalog[0]?.id;
  if (initial) await selectAsset(initial);
}

async function setSession(session) {
  state.session = session?.user?.email === APP_CONFIG.allowedEmail ? session : null;
  state.syncAvailable = Boolean(state.session);
  if (!state.session) {
    state.watchlist = [...APP_CONFIG.initialWatchlist];
    renderAssetOptions();
    return;
  }
  const [watchlistResponse, rememberedResponse] = await Promise.all([
    client.from("watchlist_items").select("asset").order("created_at"),
    client.from("audio_listener_assets").select("asset").order("created_at"),
  ]);
  const error = watchlistResponse.error ?? rememberedResponse.error;
  if (error) {
    state.session = null;
    state.syncAvailable = false;
    renderAssetOptions();
    setStatus(`SYNC UNAVAILABLE · ${error.message}`);
    return;
  }
  state.watchlist = (watchlistResponse.data ?? []).map(({ asset }) => asset);
  state.remembered = [...new Set([...state.remembered, ...(rememberedResponse.data ?? []).map(({ asset }) => asset)])];
  if (state.remembered.length) {
    const { error: syncError } = await client.from("audio_listener_assets").upsert(
      state.remembered.map((asset) => ({ user_id: state.session.user.id, asset })),
      { onConflict: "user_id,asset" },
    );
    if (syncError) state.syncAvailable = false;
  }
  writeRememberedAssets();
  renderAssetOptions();
}

function listenerAssets() {
  return listenerAssetCatalog(state.watchlist, state.remembered, state.catalog);
}

function renderAssetOptions() {
  const assets = listenerAssets();
  elements.knownAssets.replaceChildren(...assets.map((market) => {
    const option = document.createElement("option");
    option.value = market.id;
    option.textContent = displayAssetSymbol(market);
    return option;
  }));
  if (assets.some(({ id }) => id === state.selectedId)) elements.knownAssets.value = state.selectedId;
  elements.state.textContent = state.syncAvailable ? "SYNCED" : "LOCAL";
}

async function selectSearchedAsset(event) {
  event.preventDefault();
  const market = picker.selectedAsset;
  if (!market) return setStatus("CHOOSE AN ASSET FROM THE LIST");
  try {
    await rememberAsset(market.id);
    picker.clear();
    await selectAsset(market.id);
  } catch (error) {
    setStatus(error.message ?? "ASSET SELECTION FAILED");
  }
}

async function selectKnownAsset() {
  const assetId = elements.knownAssets.value;
  await rememberAsset(assetId);
  await selectAsset(assetId);
}

async function rememberAsset(assetId) {
  state.remembered = [...new Set([...state.remembered, assetId])];
  writeRememberedAssets();
  if (state.session && state.syncAvailable) {
    const { error } = await client.from("audio_listener_assets").upsert(
      { user_id: state.session.user.id, asset: assetId },
      { onConflict: "user_id,asset" },
    );
    if (error) state.syncAvailable = false;
  }
  renderAssetOptions();
}

async function selectAsset(assetId) {
  const market = state.catalog.find(({ id }) => id === assetId);
  if (!market || assetId === state.selectedId) return;
  if (state.playing) stopAudio();
  state.selectedId = market.id;
  state.latestMarket = null;
  elements.knownAssets.value = market.id;
  elements.symbol.textContent = displayAssetSymbol(market);
  elements.price.textContent = "—";
  elements.meta.textContent = "LOADING MARK PRICE";
  elements.buttonLabel.textContent = `PLAY ${displayAssetSymbol(market)}`;
  elements.buttonDetail.textContent = "PRICE EVERY 10 SECONDS";
  elements.toggle.disabled = true;
  updateMediaMetadata();
  await refreshPrice();
}

async function refreshPrice() {
  const assetId = state.selectedId;
  const token = ++state.refreshToken;
  if (!assetId) return;
  try {
    setStatus(`GETTING ${displayAssetSymbol({ id: assetId })} MARK`);
    const dex = assetId.includes(":") ? assetId.split(":", 1)[0] : "";
    const markets = await fetchMarketsForDex(dex, fetchWithTimeout);
    const market = markets.find(({ id }) => id === assetId);
    if (!market || !Number.isFinite(market.markPrice)) throw new Error("MARK PRICE UNAVAILABLE");
    if (token !== state.refreshToken || assetId !== state.selectedId) return;
    state.latestMarket = market;
    elements.price.textContent = formatPrice(market.markPrice);
    elements.meta.textContent = `MARK · UPDATED ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`;
    elements.toggle.disabled = elements.stream.canPlayType("audio/mpeg") === "";
    if (!state.playing) setStatus("STREAM IS OFF");
    scheduleNext();
  } catch (error) {
    if (token !== state.refreshToken || assetId !== state.selectedId) return;
    setStatus(error.message ?? "PRICE UNAVAILABLE");
    if (state.playing) scheduleNext();
  }
}

function startAudio() {
  if (!state.latestMarket) return setStatus("WAIT FOR A LIVE MARK PRICE");
  elements.stream.src = audioStreamUrl(STREAM_URL, state.selectedId);
  elements.stream.load();
  setPlaying(true);
  refreshPrice();
  const request = elements.stream.play();
  request?.catch(() => { setPlaying(false); setStatus("AUDIO COULD NOT START. TAP PLAY TO RETRY"); });
}

function stopAudio() {
  elements.stream.pause();
  elements.stream.removeAttribute("src");
  elements.stream.load();
  setPlaying(false);
}

function setPlaying(playing) {
  if (state.playing === playing) return;
  state.playing = playing;
  elements.toggle.setAttribute("aria-pressed", String(playing));
  elements.console.classList.toggle("is-playing", playing);
  elements.buttonLabel.textContent = `${playing ? "STOP" : "PLAY"} ${selectedSymbol()}`;
  elements.buttonDetail.textContent = playing ? "PRICE ANNOUNCEMENTS ACTIVE" : "PRICE EVERY 10 SECONDS";
  if (playing) scheduleNext();
  else {
    window.clearTimeout(state.timer);
    window.clearInterval(state.countdownTimer);
    state.timer = null;
    state.countdownTimer = null;
    setStatus("STREAM IS OFF");
  }
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
}

function scheduleNext() {
  if (!state.playing) return;
  window.clearTimeout(state.timer);
  window.clearInterval(state.countdownTimer);
  state.nextAnnouncementAt = Date.now() + INTERVAL_MS;
  updateCountdown();
  state.countdownTimer = window.setInterval(updateCountdown, 250);
  state.timer = window.setTimeout(refreshPrice, INTERVAL_MS);
}

function updateCountdown() {
  if (!state.playing) return;
  const seconds = Math.max(0, Math.ceil((state.nextAnnouncementAt - Date.now()) / 1000));
  setStatus(`${selectedSymbol()} LIVE · NEXT PRICE IN ${seconds}S`);
}

function updateMediaMetadata() {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `${selectedSymbol()} Price Audio`,
    artist: "HYPERDATA",
    album: "Live mark price every 10 seconds",
  });
}

function setStatus(message) {
  elements.status.textContent = String(message).toUpperCase();
}

function selectedSymbol() {
  const market = state.catalog.find(({ id }) => id === state.selectedId);
  return displayAssetSymbol(market ?? { id: state.selectedId });
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), MARKET_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function readRememberedAssets() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((asset) => typeof asset === "string") : [];
  } catch {
    return [];
  }
}

function writeRememberedAssets() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.remembered)); } catch { /* storage is optional */ }
}

function formatPrice(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1 ? 2 : 0,
    maximumFractionDigits: value >= 1 ? 2 : 6,
  }).format(value);
}

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", startAudio);
  navigator.mediaSession.setActionHandler("pause", stopAudio);
}
