import { CANDLE_INTERVALS } from "./hyperliquid.js?v=20261110-marks";
import { normalizeChartPreferences } from "./chart-grid.js?v=20261110-charts3";

export const COMPARISON_DEFAULTS = { assetA: "BTC", assetB: "ETH", interval: "1h", window: 604800, mode: "percent", range: null, startTime: null, basis: "market", entryA: null, entryB: null, anchor: null, followNow: true };
const validAsset = (asset) => typeof asset === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(asset);

export function comparisonPreferences(input = {}) {
  if (!input || typeof input !== "object") input = {};
  const { interval, window } = normalizeChartPreferences(input);
  const range = input.range;
  const startTime = Number.isFinite(input.startTime) && input.startTime > 0 ? input.startTime : null;
  const basis = input.basis === "entry" ? "entry" : "market";
  const positive = (value) => Number.isFinite(value) && value > 0 ? value : null;
  const candidate = input.anchor;
  const anchor = candidate && candidate.time === startTime && candidate.assetA === input.assetA && candidate.assetB === input.assetB && candidate.basis === basis && positive(candidate.priceA) && positive(candidate.priceB) && (basis === "market" ? startTime % 60 === 0 && candidate.source === "1m_close" : candidate.priceA === input.entryA && candidate.priceB === input.entryB)
    ? { time: candidate.time, assetA: candidate.assetA, assetB: candidate.assetB, basis, priceA: candidate.priceA, priceB: candidate.priceB, source: basis === "entry" ? "entry" : "1m_close" } : null;
  return {
    assetA: validAsset(input.assetA) ? input.assetA : "BTC",
    assetB: validAsset(input.assetB) ? input.assetB : "ETH",
    interval, window, mode: startTime !== null ? "percent" : input.mode === "price" ? "price" : "percent",
    startTime, basis, entryA: positive(input.entryA), entryB: positive(input.entryB), anchor, followNow: input.followNow !== false,
    range: range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.from > 0 && range.to > range.from ? { from: range.from, to: range.to } : null,
  };
}

export function parseComparisonStart(value) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value)) return null;
  const time = Date.parse(value + "Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, value.length) === value ? time / 1000 : null;
}

export function intervalForStart(interval, start, now = Date.now() / 1000) {
  const requested = Math.max(0, CANDLE_INTERVALS.findIndex((item) => item.value === interval));
  return CANDLE_INTERVALS.slice(requested).find((item) => Math.ceil((now - start) * 1000 / item.milliseconds) + 10 <= 4900)?.value ?? "1M";
}

export function marketStartAnchor(barsA, barsB, settings) {
  if (!settings.startTime || settings.startTime % 60 !== 0) throw new Error("Market baselines use full UTC minutes. Select an exact minute, or enter your fill prices for second precision.");
  const reference = settings.startTime - 60;
  const find = (bars) => bars.find((bar) => bar.time === reference && Number.isFinite(bar.close) && bar.close > 0);
  const a = find(barsA), b = find(barsB);
  if (!a || !b) throw new Error("The shared one-minute baseline is unavailable at this start. Choose another minute or enter your actual fill prices; an approximate price will not be substituted.");
  return { time: settings.startTime, assetA: settings.assetA, assetB: settings.assetB, priceA: a.close, priceB: b.close, basis: "market", source: "1m_close" };
}

export function entryStartAnchor(settings) {
  if (![settings.entryA, settings.entryB].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Enter a positive fill price for each leg.");
  return { time: settings.startTime, assetA: settings.assetA, assetB: settings.assetB, priceA: settings.entryA, priceB: settings.entryB, basis: "entry", source: "entry" };
}

export function latestTradeQuote(previous, trade, asset, startTime, now = Date.now() / 1000) {
  const amount = Number(trade.px), time = Number(trade.time) / 1000;
  if (trade.coin !== asset || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(time) || time < startTime || time > now + 5) return previous;
  if (previous?.source === "trade" && time < previous.time) return previous;
  return { price: amount, time, source: "trade" };
}

// Fixed-start price returns use closes at their END timestamps, never the
// beginning of a candle whose close was not known yet. Live endpoints use each
// leg's last observed trade/snapshot, with its original age displayed in the UI.
export function anchoredComparisonModel(barsA, barsB, { anchor, interval, to = Date.now() / 1000, live = [] }) {
  if (!anchor || to < anchor.time) return { baseline: null, rows: [], gaps: 0 };
  const closeMap = (bars) => new Map(bars.filter((bar) => Number.isFinite(bar.close) && bar.close > 0).map((bar) => [candleEnd(bar.time, interval), bar.close]).filter(([time]) => time > anchor.time && time <= to));
  const a = closeMap(barsA), b = closeMap(barsB);
  const times = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
  let gaps = 0, previous = anchor.time;
  const row = (time, pa, pb, extra = {}) => ({ time, priceA: pa, priceB: pb, returnA: pa === undefined ? undefined : (pa / anchor.priceA - 1) * 100, returnB: pb === undefined ? undefined : (pb / anchor.priceB - 1) * 100, ...extra });
  const rows = [row(anchor.time, anchor.priceA, anchor.priceB, { anchor: true })];
  for (const time of times) {
    if (candleEnd(previous, interval) < time) { rows.push({ time: candleEnd(previous, interval) }); gaps++; }
    const pa = a.get(time), pb = b.get(time);
    if (pa === undefined || pb === undefined) gaps++;
    rows.push(row(time, pa, pb)); previous = time;
  }
  const latest = live.map((point) => point && Number.isFinite(point.time) && Number.isFinite(point.price) && point.time >= anchor.time && point.time <= to && point.price > 0 ? point.price : undefined);
  if (to > rows.at(-1).time && latest.some((value) => value !== undefined)) rows.push(row(to, latest[0], latest[1], { live: true }));
  return { baseline: anchor, rows, gaps };
}

export function candleEnd(time, interval) {
  if (interval === "1M") {
    const date = new Date(time * 1000);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
  }
  return time + CANDLE_INTERVALS.find((item) => item.value === interval).milliseconds / 1000;
}

// A return comparison needs one shared, completed baseline. Each plotted pair
// then uses real closes from the same candle, never an independently rebased or
// carried-forward observation. Missing intervals remain whitespace in the plot.
export function comparisonModel(barsA, barsB, { interval = "1h", from = 0, baselineFrom = from, to = Date.now() / 1000, baselineTime = null } = {}) {
  const clean = (bars) => new Map(bars.filter((bar) => Number.isFinite(bar.time) && bar.time >= from && bar.time <= to && Number.isFinite(bar.close) && bar.close > 0).map((bar) => [bar.time, bar.close]));
  const a = clean(barsA), b = clean(barsB);
  const times = [...new Set([...a.keys(), ...b.keys()])].sort((left, right) => left - right);
  const baseTime = baselineTime ?? times.find((time) => time >= baselineFrom && a.has(time) && b.has(time) && candleEnd(time, interval) <= to);
  if (baseTime === undefined || !a.has(baseTime) || !b.has(baseTime)) return { baseline: null, rows: [], gaps: 0 };
  const baseline = { time: baseTime, priceA: a.get(baseTime), priceB: b.get(baseTime) };
  let gaps = 0;
  let previous = null;
  const rows = times.flatMap((time) => {
    const gap = previous !== null && candleEnd(previous, interval) < time ? [{ time: candleEnd(previous, interval) }] : [];
    if (gap.length) gaps++;
    previous = time;
    if (!a.has(time) || !b.has(time)) { gaps++; return [...gap, { time }]; }
    return [...gap, { time, priceA: a.get(time), priceB: b.get(time), returnA: (a.get(time) / baseline.priceA - 1) * 100, returnB: (b.get(time) / baseline.priceB - 1) * 100, forming: candleEnd(time, interval) > to }];
  });
  return { baseline, rows, gaps };
}

export function comparisonSeries(model, mode = "percent") {
  return ["A", "B"].map((side) => {
    const lastValid = model.rows.findLastIndex((row) => row["price" + side] !== undefined);
    return model.rows.map((row, index) => {
    if (row["price" + side] === undefined) return { time: row.time };
    const point = { time: row.time, value: row[(mode === "price" ? "price" : "return") + side] };
    // Lightweight Charts skips whitespace when drawing lines. Hide the outgoing
    // segment before each interior gap so it cannot bridge missing observations.
    if (index < lastValid && model.rows[index + 1]?.["price" + side] === undefined) point.color = "transparent";
    return point;
    });
  });
}
