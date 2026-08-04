const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function candleSecondsToMilliseconds(candle) {
  return { ...candle, time: Number(candle.time) * 1000 };
}

export function candleMillisecondsToSeconds(candle) {
  return { ...candle, time: Math.floor(Number(candle.time) / 1000) };
}

export function splitLevelCandles(candles, now = Date.now()) {
  const normalized = candles
    .map((candle) => Number(candle.time) < 10_000_000_000 ? candleSecondsToMilliseconds(candle) : { ...candle })
    .sort((left, right) => left.time - right.time);
  const completed = normalized.filter(({ time }) => time + FIVE_MINUTES_MS <= now);
  const live = normalized.findLast(({ time }) => time + FIVE_MINUTES_MS > now) ?? null;
  return { completed, live };
}

export function mergeLevelCandle(candles, candle, limit = 5_000) {
  if (!candle) return candles;
  const normalized = Number(candle.time) < 10_000_000_000 ? candleSecondsToMilliseconds(candle) : candle;
  const byTime = new Map(candles.map((item) => [item.time, item]));
  byTime.set(normalized.time, normalized);
  return [...byTime.values()].sort((left, right) => left.time - right.time).slice(-limit);
}

export function assessLevelData(candles, now = Date.now()) {
  if (!candles.length) return { usable: false, barCount: 0, ageMs: Infinity, gaps: 0, message: "NO CANDLE DATA" };
  const ordered = [...candles].sort((left, right) => left.time - right.time);
  const ageMs = Math.max(0, now - (ordered.at(-1).time + FIVE_MINUTES_MS));
  let gaps = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].time - ordered[index - 1].time > FIVE_MINUTES_MS * 1.5) gaps += 1;
  }
  const usable = ordered.length >= 80 && ageMs <= 20 * 60 * 1000;
  return {
    usable,
    barCount: ordered.length,
    ageMs,
    gaps,
    message: ordered.length < 80 ? "AT LEAST 80 COMPLETED BARS REQUIRED" : ageMs > 20 * 60 * 1000 ? "LATEST COMPLETED BAR IS STALE" : "READY",
  };
}

export function defaultLevelSession(market) {
  return ["stocks", "stock", "equities", "equity", "etfs", "etf"].includes(String(market?.category ?? "").toLowerCase())
    ? "new_york_rth"
    : "utc";
}

export const LEVEL_BAR_MS = FIVE_MINUTES_MS;
