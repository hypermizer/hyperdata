const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const number = (value) => Number(value);
const finite = (value) => Number.isFinite(number(value));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const median = (values) => {
  const ordered = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!ordered.length) return NaN;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

const formatterCache = new Map();
function zonedParts(time, timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    formatterCache.set(timeZone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(time)).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
}

export function groupSessionKey(time, mode = "utc") {
  const timeZone = mode === "new_york_rth" ? "America/New_York" : "UTC";
  const parts = zonedParts(time, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function inSession(time, mode) {
  if (mode !== "new_york_rth") return true;
  const parts = zonedParts(time, "America/New_York");
  if (["Sat", "Sun"].includes(parts.weekday)) return false;
  const minutes = number(parts.hour) * 60 + number(parts.minute);
  return minutes >= 570 && minutes < 960;
}

export function validateOhlcv(input, minimumBars = 80) {
  const byTime = new Map();
  for (const raw of input ?? []) {
    const bar = {
      time: number(raw.time),
      open: number(raw.open),
      high: number(raw.high),
      low: number(raw.low),
      close: number(raw.close),
      volume: number(raw.volume),
      trades: finite(raw.trades) ? number(raw.trades) : null,
    };
    if (!Object.values(bar).slice(0, 6).every(Number.isFinite)) continue;
    if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high) || bar.volume < 0) {
      throw new Error("Found invalid OHLCV relationships.");
    }
    byTime.set(bar.time, bar);
  }
  const bars = [...byTime.values()].toSorted((a, b) => a.time - b.time);
  if (bars.length < minimumBars) throw new Error(`Provide at least ${minimumBars} bars.`);
  return bars;
}

function resample(bars, intervalMinutes) {
  const size = intervalMinutes * MINUTE;
  const groups = new Map();
  for (const bar of bars) {
    const key = Math.floor(bar.time / size) * size;
    const current = groups.get(key);
    if (!current) groups.set(key, { ...bar, time: key });
    else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume += bar.volume;
      current.trades = current.trades === null || bar.trades === null ? null : current.trades + bar.trades;
    }
  }
  return [...groups.values()].toSorted((a, b) => a.time - b.time);
}

function dailyBars(bars, sessionMode) {
  const groups = new Map();
  for (const bar of bars.filter(({ time }) => inSession(time, sessionMode))) {
    const key = groupSessionKey(bar.time, sessionMode);
    const current = groups.get(key);
    if (!current) groups.set(key, { ...bar, sessionKey: key });
    else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume += bar.volume;
    }
  }
  return [...groups.values()];
}

export function trueRange(bars) {
  return bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close)));
}

export function atr(bars, period = 14) {
  const ranges = trueRange(bars);
  const output = Array(bars.length).fill(null);
  if (ranges.length < period) return output;
  let value = mean(ranges.slice(0, period));
  output[period - 1] = value;
  for (let index = period; index < ranges.length; index += 1) {
    value = ((period - 1) * value + ranges[index]) / period;
    output[index] = value;
  }
  return output;
}

function lastFinite(values, fallback) {
  return [...values].reverse().find(Number.isFinite) ?? fallback;
}

export function sessionVwap(bars, { mode = "utc" } = {}) {
  const eligible = bars.filter(({ time }) => inSession(time, mode));
  const finalKey = eligible.length ? groupSessionKey(eligible.at(-1).time, mode) : null;
  const session = eligible.filter((bar) => groupSessionKey(bar.time, mode) === finalKey);
  const volume = session.reduce((sum, bar) => sum + bar.volume, 0);
  if (!session.length || volume <= 0) return bars.at(-1).close;
  return session.reduce((sum, bar) => sum + ((bar.high + bar.low + bar.close) / 3) * bar.volume, 0) / volume;
}

function addCandidate(candidates, price, source, weight, time = null) {
  if (finite(price) && number(price) > 0) candidates.push({ price: number(price), source, weight: number(weight), time });
}

function priorCandidates(bars, daily, candidates, vwap, dailyAtr, sessionMode) {
  const sessionKeys = [...new Set(bars.filter(({ time }) => inSession(time, sessionMode)).map(({ time }) => groupSessionKey(time, sessionMode)))];
  const currentKey = sessionKeys.at(-1);
  const current = bars.filter((bar) => groupSessionKey(bar.time, sessionMode) === currentKey && inSession(bar.time, sessionMode));
  if (current.length) {
    addCandidate(candidates, current[0].open, "current_session_open", 1.4);
    addCandidate(candidates, vwap, "current_session_vwap", 2.2);
    addCandidate(candidates, Math.max(...current.map(({ high }) => high)), "current_session_high", 1.8);
    addCandidate(candidates, Math.min(...current.map(({ low }) => low)), "current_session_low", 1.8);
    const opening30 = current.filter(({ time }) => time - current[0].time <= 30 * MINUTE);
    const opening60 = current.filter(({ time }) => time - current[0].time <= 60 * MINUTE);
    if (opening30.length >= 2) {
      addCandidate(candidates, Math.max(...opening30.map(({ high }) => high)), "opening_range_30m_high", 2.4);
      addCandidate(candidates, Math.min(...opening30.map(({ low }) => low)), "opening_range_30m_low", 2.4);
    }
    if (opening60.length >= 2) {
      addCandidate(candidates, Math.max(...opening60.map(({ high }) => high)), "opening_range_60m_high", 2);
      addCandidate(candidates, Math.min(...opening60.map(({ low }) => low)), "opening_range_60m_low", 2);
    }
  }
  if (sessionKeys.length >= 2) {
    const previousKey = sessionKeys.at(-2);
    const previous = bars.filter((bar) => groupSessionKey(bar.time, sessionMode) === previousKey && inSession(bar.time, sessionMode));
    const previousClose = previous.at(-1).close;
    const previousVolume = previous.reduce((sum, bar) => sum + bar.volume, 0);
    const previousVwap = previousVolume > 0
      ? previous.reduce((sum, bar) => sum + ((bar.high + bar.low + bar.close) / 3) * bar.volume, 0) / previousVolume
      : previousClose;
    addCandidate(candidates, Math.max(...previous.map(({ high }) => high)), "prior_day_high", 3.2);
    addCandidate(candidates, Math.min(...previous.map(({ low }) => low)), "prior_day_low", 3.2);
    addCandidate(candidates, previousClose, "prior_day_close", 2.2);
    addCandidate(candidates, previousVwap, "prior_day_vwap", 1.9);
    if (current.length && Math.abs(current[0].open - previousClose) >= Math.max(0.15 * dailyAtr, previousClose * 0.002)) {
      addCandidate(candidates, current[0].open, "gap_current_open", 1.8);
      addCandidate(candidates, previousClose, "gap_prior_close", 2);
    }
  }
  if (daily.length >= 2) {
    addCandidate(candidates, daily.at(-2).high, "prior_daily_high", 2.4);
    addCandidate(candidates, daily.at(-2).low, "prior_daily_low", 2.4);
  }
  const priorWeek = daily.slice(-10, -5);
  if (priorWeek.length) {
    addCandidate(candidates, Math.max(...priorWeek.map(({ high }) => high)), "prior_week_high", 3.7);
    addCandidate(candidates, Math.min(...priorWeek.map(({ low }) => low)), "prior_week_low", 3.7);
    addCandidate(candidates, priorWeek.at(-1).close, "prior_week_close", 2.3);
  }
}

function confirmedSwings(bars, window, label, baseWeight, maxEachSide, candidates) {
  const highs = [];
  const lows = [];
  for (let index = window; index < bars.length - window; index += 1) {
    const slice = bars.slice(index - window, index + window + 1);
    if (bars[index].high === Math.max(...slice.map(({ high }) => high))) highs.push({ index, price: bars[index].high, time: bars[index].time });
    if (bars[index].low === Math.min(...slice.map(({ low }) => low))) lows.push({ index, price: bars[index].low, time: bars[index].time });
  }
  for (const [points, source] of [[highs.slice(-maxEachSide), `${label}_swing_high`], [lows.slice(-maxEachSide), `${label}_swing_low`]]) {
    for (const point of points) {
      const age = bars.length - point.index - 1;
      const recency = 0.65 + 0.35 * Math.exp(-age / Math.max(25, bars.length * 0.2));
      addCandidate(candidates, point.price, source, baseWeight * recency, point.time);
    }
  }
}

function volumeProfileCandidates(bars, candidates, bins = 60, lookback = 1500) {
  const sample = bars.slice(-lookback);
  const totalVolume = sample.reduce((sum, bar) => sum + bar.volume, 0);
  if (!sample.length || totalVolume <= 0) return;
  const low = Math.min(...sample.map((bar) => bar.low));
  const high = Math.max(...sample.map((bar) => bar.high));
  if (high <= low) return;
  const width = (high - low) / bins;
  const profile = Array(bins).fill(0);
  for (const bar of sample) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    profile[Math.max(0, Math.min(bins - 1, Math.floor((typical - low) / width)))] += bar.volume;
  }
  const center = (index) => low + (index + 0.5) * width;
  const poc = profile.indexOf(Math.max(...profile));
  addCandidate(candidates, center(poc), "volume_profile_poc", 3.2);
  let left = poc;
  let right = poc;
  let accumulated = profile[poc];
  while (accumulated < totalVolume * 0.7 && (left > 0 || right < bins - 1)) {
    if ((profile[right + 1] ?? -1) >= (profile[left - 1] ?? -1)) accumulated += profile[++right];
    else accumulated += profile[--left];
  }
  addCandidate(candidates, center(left), "volume_profile_val", 2.4);
  addCandidate(candidates, center(right), "volume_profile_vah", 2.4);
  const peaks = profile.map((value, index) => ({ value, index }))
    .filter(({ value, index }) => index > 0 && index < bins - 1 && value >= profile[index - 1] && value >= profile[index + 1])
    .toSorted((a, b) => b.value - a.value);
  const selected = [poc, left, right];
  for (const { index } of peaks) {
    if (selected.every((existing) => Math.abs(index - existing) >= 3)) {
      addCandidate(candidates, center(index), "volume_profile_hvn", 1.9);
      selected.push(index);
    }
    if (selected.length >= 6) break;
  }
}

function niceStep(target) {
  const exponent = Math.floor(Math.log10(Math.max(target, 1e-8)));
  const fraction = target / (10 ** exponent);
  const choice = [1, 2, 2.5, 5, 10].reduce((best, value) => Math.abs(value - fraction) < Math.abs(best - fraction) ? value : best);
  return choice * (10 ** exponent);
}

function roundCandidates(current, dailyAtr, candidates) {
  const step = niceStep(Math.max(current * 0.0025, dailyAtr * 0.25));
  for (let price = Math.floor((current - 2.5 * dailyAtr) / step) * step; price <= current + 2.5 * dailyAtr + step; price += step) {
    addCandidate(candidates, price, `round_number_${step}`, 0.65);
  }
}

function touchEpisodes(mask) {
  return mask.reduce((count, value, index) => count + (value && !mask[index - 1] ? 1 : 0), 0);
}

export function clusterLevelCandidates(candidates, scoringBars, current, tolerance, proximityScale) {
  const ordered = candidates.toSorted((a, b) => a.price - b.price);
  const clusters = [];
  for (const candidate of ordered) {
    const cluster = clusters.at(-1);
    if (!cluster) clusters.push([candidate]);
    else {
      const weight = cluster.reduce((sum, item) => sum + item.weight, 0);
      const center = cluster.reduce((sum, item) => sum + item.price * item.weight, 0) / weight;
      if (Math.abs(candidate.price - center) <= tolerance) cluster.push(candidate);
      else clusters.push([candidate]);
    }
  }
  const recent = scoringBars.slice(-800);
  const medianVolume = Math.max(median(recent.map(({ volume }) => volume)) || 0, 1);
  return clusters.map((cluster) => {
    const weightTotal = cluster.reduce((sum, item) => sum + item.weight, 0);
    const center = cluster.reduce((sum, item) => sum + item.price * item.weight, 0) / weightTotal;
    const prices = cluster.map(({ price }) => price);
    const zoneLow = Math.min(...prices) - 0.3 * tolerance;
    const zoneHigh = Math.max(...prices) + 0.3 * tolerance;
    const near = recent.map((bar) => bar.low <= zoneHigh && bar.high >= zoneLow);
    const touches = touchEpisodes(near);
    let crossings = 0;
    for (let index = 1; index < recent.length; index += 1) if ((recent[index].close - center) * (recent[index - 1].close - center) < 0) crossings += 1;
    const nearVolumes = recent.filter((_, index) => near[index]).map(({ volume }) => volume);
    const volumeRatio = nearVolumes.length ? median(nearVolumes) / medianVolume : 0;
    const lastNear = near.lastIndexOf(true);
    const lastTouchBars = lastNear >= 0 ? recent.length - 1 - lastNear : recent.length;
    const sources = [...new Set(cluster.map(({ source }) => source))].toSorted();
    const sourceMap = new Map();
    for (const item of cluster) sourceMap.set(item.source, [...(sourceMap.get(item.source) ?? []), item.weight]);
    const source = [...sourceMap.values()].reduce((sum, weights) => sum + Math.max(...weights) + Math.min(Math.max(weights.length - 1, 0), 4) * 0.1, 0);
    const touch = Math.min(touches, 5) * 0.42;
    const volume = Math.min(volumeRatio, 3) * 0.25;
    const diversity = Math.min(new Set(sources.map((value) => value.split("_")[0])).size, 4) * 0.3;
    const cleanliness = Math.max(-1.2, 0.75 - crossings * 0.12);
    const recency = 0.55 * Math.exp(-lastTouchBars / 120);
    const proximity = Math.min(Math.abs(center - current) / Math.max(proximityScale, 1e-9), 4) * 0.25;
    const scoreComponents = { source, touch, volume, diversity, cleanliness, recency, proximity: -proximity };
    return {
      center,
      zoneLow,
      zoneHigh,
      role: current < zoneLow ? "resistance" : current > zoneHigh ? "support" : "at_price",
      score: Math.round(Object.values(scoreComponents).reduce((sum, value) => sum + value, 0) * 100) / 100,
      scoreComponents,
      confluence: sources.length,
      touches,
      crossings,
      distancePct: (center / current - 1) * 100,
      sources,
    };
  }).filter(({ center }) => Math.abs(center - current) <= 3 * proximityScale)
    .toSorted((a, b) => b.score - a.score || b.confluence - a.confluence);
}

function ema(values, span) {
  const alpha = 2 / (span + 1);
  const output = [];
  for (const value of values) output.push(output.length ? alpha * value + (1 - alpha) * output.at(-1) : value);
  return output;
}

function trendRegime(frame15, frame60, vwap) {
  const closes15 = frame15.map(({ close }) => close);
  const closes60 = frame60.map(({ close }) => close);
  const ema20 = ema(closes15, 20);
  const ema50 = ema(closes15, 50);
  const ema20_60 = ema(closes60, 20);
  const ema50_60 = ema(closes60, 50);
  const current = closes15.at(-1);
  const atr15 = lastFinite(atr(frame15), median(frame15.map((bar) => bar.high - bar.low)));
  let score = current > ema20.at(-1) ? 1 : -1;
  score += ema20.at(-1) > ema50.at(-1) ? 1 : -1;
  score += current > vwap ? 1 : -1;
  if (ema20.length >= 6) {
    const slope = ema20.at(-1) - ema20.at(-6);
    if (slope > 0.15 * atr15) score += 1;
    else if (slope < -0.15 * atr15) score -= 1;
  }
  if (ema20_60.length >= 20) score += ema20_60.at(-1) > ema50_60.at(-1) ? 1 : -1;
  const regime = score >= 4 ? "strong_uptrend" : score >= 2 ? "uptrend" : score <= -4 ? "strong_downtrend" : score <= -2 ? "downtrend" : "range_or_transition";
  return { regime, trendScore: score, ema20_15m: ema20.at(-1), ema50_15m: ema50.at(-1), vwap };
}

function targets(levels, entry, direction, gap) {
  return levels.filter(({ center }) => direction === "long" ? center > entry + gap : center < entry - gap)
    .toSorted((a, b) => direction === "long" ? a.center - b.center : b.center - a.center)
    .slice(0, 4).map(({ center }) => center);
}

function buildSetups(levels, current, atr15, dailyAtr, riskDollars, regime) {
  const buffer = Math.max(current * 0.0008, atr15 * 0.25, dailyAtr * 0.03);
  const triggerBuffer = Math.max(current * 0.0004, atr15 * 0.1);
  const distance = Math.max(1.75 * dailyAtr, 5 * atr15);
  const supports = levels.filter((level) => level.center < current && current - level.center <= distance);
  const resistances = levels.filter((level) => level.center > current && level.center - current <= distance);
  const strongest = (items) => items.toSorted((a, b) => (b.score - 0.35 * Math.abs(b.center - current) / Math.max(dailyAtr, atr15)) - (a.score - 0.35 * Math.abs(a.center - current) / Math.max(dailyAtr, atr15)))[0];
  const nearestSupport = supports.toSorted((a, b) => b.center - a.center)[0];
  const nearestResistance = resistances.toSorted((a, b) => a.center - b.center)[0];
  const rows = [];
  function append(setup, direction, level, entryLow, entryHigh, entry, stop, confirmation) {
    if (!level) return;
    const riskPerShare = Math.abs(entry - stop);
    if (riskPerShare <= 0) return;
    const choices = targets(levels, entry, direction, Math.max(0.35 * riskPerShare, 0.15 * atr15));
    const target1 = choices[0] ?? entry + (direction === "long" ? dailyAtr : -dailyAtr);
    const target2 = choices[1] ?? entry + (direction === "long" ? 2 * dailyAtr : -2 * dailyAtr);
    const reward = (target) => direction === "long" ? target - entry : entry - target;
    const rr1 = reward(target1) / riskPerShare;
    const rr2 = reward(target2) / riskPerShare;
    const aligned = direction === "long" ? ["uptrend", "strong_uptrend"].includes(regime) : ["downtrend", "strong_downtrend"].includes(regime);
    const opposed = direction === "long" ? regime === "strong_downtrend" : regime === "strong_uptrend";
    const setupScore = level.score + (aligned ? 1 : opposed ? -1 : 0) + Math.min(Math.max(rr1, 0), 3) * 0.35;
    rows.push({
      setup, direction, entryZoneLow: entryLow, entryZoneHigh: entryHigh, entryReference: entry, stop, riskPerShare,
      target1, rr1, target2, rr2, sharesAtRiskBudget: riskDollars > 0 ? Math.floor(riskDollars / riskPerShare) : null,
      levelScore: level.score, setupScore,
      status: rr1 >= 1.5 && level.score >= 3 ? "actionable_after_confirmation" : rr2 >= 1.5 && level.score >= 2 ? "watch" : "poor_reward_or_weak_level",
      confirmation,
    });
  }
  const support = strongest(supports);
  const resistance = strongest(resistances);
  append("long_pullback", "long", support, support?.zoneLow, support?.zoneHigh, support?.center, support?.zoneLow - buffer, "Enter zone, reject lower prices, then reclaim midpoint or VWAP on expanding volume.");
  append("long_breakout_retest", "long", nearestResistance, nearestResistance?.zoneLow, nearestResistance?.zoneHigh + triggerBuffer, nearestResistance?.zoneHigh, nearestResistance?.zoneLow - buffer, "15m close above zone, then a retest holds.");
  append("short_rally_rejection", "short", resistance, resistance?.zoneLow, resistance?.zoneHigh, resistance?.center, resistance?.zoneHigh + buffer, "Enter zone, fail to accept above it, then lose midpoint or VWAP.");
  append("short_breakdown_retest", "short", nearestSupport, nearestSupport?.zoneLow - triggerBuffer, nearestSupport?.zoneHigh, nearestSupport?.zoneLow, nearestSupport?.zoneHigh + buffer, "15m close below zone, then a reclaim fails.");
  return rows.toSorted((a, b) => b.setupScore - a.setupScore);
}

export function analyzeLevels(input, { ticker = "ASSET", riskDollars = 0, sessionMode = "utc" } = {}) {
  const bars = validateOhlcv(input);
  const sessionBars = bars.filter(({ time }) => inSession(time, sessionMode));
  if (sessionBars.length < 80) throw new Error("Selected session contains fewer than 80 bars.");
  const frame15 = resample(sessionBars, 15);
  const frame60 = resample(sessionBars, 60);
  const daily = dailyBars(bars, sessionMode);
  const current = bars.at(-1).close;
  const atr15 = lastFinite(atr(frame15), median(frame15.map((bar) => bar.high - bar.low)));
  let dailyAtr = lastFinite(atr(daily), median(daily.map((bar) => bar.high - bar.low)));
  dailyAtr = Math.max(dailyAtr || 0, atr15 * 3, current * 0.005);
  const vwap = sessionVwap(bars, { mode: sessionMode });
  const candidates = [];
  priorCandidates(bars, daily, candidates, vwap, dailyAtr, sessionMode);
  confirmedSwings(frame15, 3, "15m", 1.35, 14, candidates);
  confirmedSwings(frame60, 2, "60m", 2.15, 12, candidates);
  confirmedSwings(daily, 2, "daily", 3.1, 10, candidates);
  volumeProfileCandidates(frame15, candidates);
  roundCandidates(current, dailyAtr, candidates);
  const tolerance = Math.max(current * 0.001, atr15 * 0.22, dailyAtr * 0.025);
  const proximityScale = Math.max(dailyAtr, atr15 * 4);
  const levels = clusterLevelCandidates(candidates, frame15, current, tolerance, proximityScale);
  const regime = trendRegime(frame15, frame60, vwap);
  return {
    levels,
    setups: buildSetups(levels, current, atr15, dailyAtr, number(riskDollars), regime.regime),
    summary: {
      ticker: String(ticker).toUpperCase(), lastPrice: current, barCount: bars.length, sessionBarCount: sessionBars.length,
      coverageStart: bars[0].time, coverageEnd: bars.at(-1).time, atr15m: atr15, dailyAtr, sessionVwap: vwap,
      sessionMode, volumeSource: "Hyperliquid perpetual venue", ...regime,
    },
  };
}

export const LEVEL_SESSION_MODES = [
  { value: "new_york_rth", label: "NEW YORK RTH" },
  { value: "utc", label: "UTC 24H" },
];
