import { CANDLE_INTERVALS } from "./hyperliquid.js?v=20261110-marks";
import { normalizeChartPreferences } from "./chart-grid.js?v=20261110-charts3";

export const COMPARISON_DEFAULTS = { assetA: "BTC", assetB: "ETH", interval: "1h", window: 604800, mode: "percent", range: null };
const validAsset = (asset) => typeof asset === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(asset);

export function comparisonPreferences(input = {}) {
  if (!input || typeof input !== "object") input = {};
  const { interval, window } = normalizeChartPreferences(input);
  const range = input.range;
  return {
    assetA: validAsset(input.assetA) ? input.assetA : "BTC",
    assetB: validAsset(input.assetB) ? input.assetB : "ETH",
    interval, window, mode: input.mode === "price" ? "price" : "percent",
    range: range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.from > 0 && range.to > range.from ? { from: range.from, to: range.to } : null,
  };
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
  const lastValid = model.rows.findLastIndex((row) => row.priceA !== undefined);
  return ["A", "B"].map((side) => model.rows.map((row, index) => {
    if (row["price" + side] === undefined) return { time: row.time };
    const point = { time: row.time, value: row[(mode === "price" ? "price" : "return") + side] };
    // Lightweight Charts skips whitespace when drawing lines. Hide the outgoing
    // segment before each interior gap so it cannot bridge missing observations.
    if (index < lastValid && model.rows[index + 1]?.priceA === undefined) point.color = "transparent";
    return point;
  }));
}
