import { CANDLE_INTERVALS, normalizeCandle, postInfo } from "./hyperliquid.js?v=20261110-marks";

export const CHART_WINDOWS = [
  ["1 HOUR", 3600], ["6 HOURS", 21600], ["12 HOURS", 43200],
  ["1 DAY", 86400], ["3 DAYS", 259200], ["1 WEEK", 604800],
  ["2 WEEKS", 1209600], ["1 MONTH", 2592000], ["3 MONTHS", 7776000],
  ["6 MONTHS", 15552000], ["1 YEAR", 31536000],
].map(([label, seconds]) => ({ label, seconds }));
export const CHART_DEFAULTS = { interval: "1h", window: 604800, columns: 3, rows: 2, height: 300, order: [], ranges: {}, scroll: { top: 0, left: 0 } };
const validAsset = (asset) => typeof asset === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(asset);
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

export function chartWindows(interval) {
  const step = (CANDLE_INTERVALS.find((item) => item.value === interval)?.milliseconds ?? 3600000) / 1000;
  return CHART_WINDOWS.filter(({ seconds }) => seconds >= step * 4 && seconds <= step * 4800);
}

export function normalizeChartPreferences(input = {}) {
  if (!input || typeof input !== "object") input = {};
  const interval = CANDLE_INTERVALS.some((item) => item.value === input.interval) ? input.interval : CHART_DEFAULTS.interval;
  const windows = chartWindows(interval);
  const requested = Number(input.window) || CHART_DEFAULTS.window;
  const window = windows.reduce((a, b) => Math.abs(a.seconds - requested) <= Math.abs(b.seconds - requested) ? a : b).seconds;
  const order = [...new Set((Array.isArray(input.order) ? input.order : []).filter(validAsset))].slice(0, 1000);
  const ranges = {};
  for (const [asset, range] of Object.entries(input.ranges ?? {}).slice(0, 1000)) {
    if (validAsset(asset) && range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.from > 0 && range.to > range.from) {
      ranges[asset] = { from: range.from, to: range.to };
    }
  }
  const scroll = { top: bounded(input.scroll?.top, 0, 0, 1000000), left: bounded(input.scroll?.left, 0, 0, 1000000) };
  return { interval, window, columns: bounded(input.columns, 3, 1, 6), rows: bounded(input.rows, 2, 1, 6), height: bounded(input.height, 300, 200, 700), order, ranges, scroll };
}

export function orderedChartAssets(watched, order) {
  const assets = [...new Set(watched.filter(validAsset))];
  const set = new Set(assets);
  return [...order.filter((asset) => set.delete(asset)), ...assets.filter((asset) => set.has(asset))];
}

export function moveChart(assets, source, target) {
  const from = assets.indexOf(source), to = assets.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...assets];
  const result = [...assets];
  result.splice(from, 1);
  result.splice(to, 0, source);
  return result;
}

export function chartRequest(preferences, now = Date.now(), asset = null) {
  const step = CANDLE_INTERVALS.find((item) => item.value === preferences.interval).milliseconds;
  const pinnedFrom = preferences.ranges[asset]?.from;
  const pinnedCount = pinnedFrom ? Math.ceil((now - pinnedFrom * 1000) / step) + 2 : 0;
  const count = Math.min(4900, Math.max(pinnedCount, Math.ceil(preferences.window * 1000 / step) + 10));
  return { count, startTime: Math.max(0, now - count * step), endTime: now, weight: 20 + Math.ceil(count / 60) };
}

export async function fetchChartCandles(asset, preferences, fetchImpl = fetch, now = Date.now()) {
  const request = chartRequest(preferences, now, asset);
  const response = await postInfo({ type: "candleSnapshot", req: { coin: asset, interval: preferences.interval, startTime: request.startTime, endTime: now } }, fetchImpl);
  if (!Array.isArray(response)) throw new Error("Candle history is unavailable.");
  return [...new Map(response.map(normalizeCandle).filter(Boolean).map((bar) => [bar.time, bar])).values()]
    .sort((a, b) => a.time - b.time).slice(-4900);
}
