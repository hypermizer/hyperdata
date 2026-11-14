import { createAccountPairCurve, manualPairCurve } from "./pair-trade.js";
export const PAIR_PERIODS = {
  trade: null,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
  custom: null,
};
const asset = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(v);
const uuid = (v) => typeof v === "string" && /^[a-f0-9-]{36}$/i.test(v);
export function pairViewPreferences(input = {}) {
  if (!input || typeof input !== "object") input = {};
  const ranges = {};
  for (const [id, r] of Object.entries(input.ranges ?? {}).slice(-40)) {
    if (
      uuid(id) && r && Number.isFinite(r.from) && Number.isFinite(r.to) &&
      r.from > 0 && r.to > r.from
    ) ranges[id] = { from: r.from, to: r.to };
  }
  return {
    assetA: asset(input.assetA) ? input.assetA : "BTC",
    assetB: asset(input.assetB) ? input.assetB : "ETH",
    selectedPairId: uuid(input.selectedPairId) ? input.selectedPairId : null,
    selectionSet: input.selectionSet === true,
    period: Object.hasOwn(PAIR_PERIODS, input.period) &&
        (input.period !== "custom" ||
          Number.isFinite(input.customStart) && input.customStart > 0)
      ? input.period
      : "trade",
    customStart: Number.isFinite(input.customStart) && input.customStart > 0
      ? input.customStart
      : null,
    sampling: [0, 15, 60, 300, 900, 3600, 86400].includes(input.sampling)
      ? input.sampling
      : 0,
    follow: input.follow !== false,
    ranges,
  };
}
export function pairHistoryRequest(
  pair,
  settings,
  now = Date.now(),
  pairId = pair.id,
) {
  const p = pairViewPreferences(settings), end = now / 1000;
  let start = pair.openedAt / 1000;
  if (p.period === "custom") {
    if (!p.customStart || p.customStart >= end) {
      throw Error("Choose a valid UTC start before now.");
    }
    start = Math.max(start, p.customStart);
  } else if (PAIR_PERIODS[p.period]) {
    start = Math.max(start, end - PAIR_PERIODS[p.period]);
  }
  if (!p.follow && p.ranges[pairId]) {
    start = Math.max(
      pair.openedAt / 1000,
      Math.min(start, p.ranges[pairId].from),
    );
  }
  if (start >= end) throw Error("The trade has not started yet.");
  if (end - start > 400 * 86400) {
    throw Error("Choose a range within the last 400 days.");
  }
  const minimum = Math.ceil((end - start) / 4800 / 15) * 15;
  const interval = Math.max(
    p.sampling || (end - start <= 1800 ? 15 : 60),
    minimum,
    15,
  );
  return { start, end, interval: Math.min(86400, interval) };
}
// Do not apply later fills to a price stamped before they occurred. Quotes at
// each point are the last actual observations as of that point, at most 15s old.
export function verifiedPairRows(rows, { start, end, maxAge = 15 }) {
  const byTime = new Map();
  for (const row of rows) {
    const time = Number(row.time);
    if (!Number.isFinite(time) || time < start || time > end) continue;
    const point = { ...row, time };
    for (const side of ["A", "B"]) {
      const amount = Number(row["price" + side]),
        observed = Number(
          Object.hasOwn(row, "observed" + side) ? row["observed" + side] : time,
        );
      if (
        row["price" + side] == null || !Number.isFinite(amount) ||
        amount <= 0 || !Number.isFinite(observed) || observed > time ||
        time - observed > maxAge
      ) point["price" + side] = null;
    }
    byTime.set(time, point);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
export function pairCurveEvaluator(pair, account) {
  return pair.source === "account"
    ? createAccountPairCurve(pair, account.fills, account.funding)
    : (rows) => manualPairCurve(pair, rows);
}
export function pairChartModel(pair, history, live, evaluate, request) {
  const observations = verifiedPairRows([...history, ...live], request),
    slots = new Map();
  for (const row of observations) {
    const slot = Math.floor(row.time / request.interval);
    const previous = slots.get(slot);
    if (!previous || previous.time <= row.time) {
      slots.set(slot, { ...row, slot });
    }
  }
  const raw = [...slots.values()].sort((a, b) => a.time - b.time),
    values = evaluate(raw);
  // Chart timestamps must be strictly increasing whole seconds. Keep the latest
  // observed point when two updates land in the same second.
  const sourceRows = new Map(raw.map((row) => [row.time, row]));
  const points = new Map();
  for (const row of values) {
    points.set(Math.floor(row.time), {
      ...row,
      asOf: row.time,
      priceA: sourceRows.get(row.time)?.priceA,
      priceB: sourceRows.get(row.time)?.priceB,
      time: Math.floor(row.time),
    });
  }
  const rows = [...points.values()];
  const keys = pair.source === "account"
    ? ["valueA", "valueB", "value"]
    : ["value"];
  const series = keys.map((key) =>
    rows.map((row, index) => {
      const point = {
          time: row.time,
          ...(Number.isFinite(row[key]) ? { value: row[key] } : {}),
        },
        next = rows[index + 1];
      if (
        next &&
        (!Number.isFinite(next[key]) ||
          next.time - row.time > Math.max(90, request.interval * 1.5))
      ) point.color = "transparent";
      return point;
    })
  );
  for (const data of series) {
    if (data.length) {
      const start = Math.floor(request.start), end = Math.floor(request.end);
      if (data[0].time > start) data.unshift({ time: start });
      if (data.at(-1).time < end) data.push({ time: end });
    }
  }
  return {
    rows,
    interval: request.interval,
    requestedStart: request.start,
    series,
    first: rows.find((r) => Number.isFinite(r.value)),
    last: rows.findLast((r) => Number.isFinite(r.value)),
    missing: rows.filter((r) => !Number.isFinite(r.value)).length,
    gaps: rows.filter((row, i) =>
      i > 0 &&
      row.time - rows[i - 1].time > Math.max(90, request.interval * 1.5)
    ).length,
  };
}
export function livePairObservation(pair, valuation, quotes, now = Date.now()) {
  if (
    !valuation?.fresh || pair.source === "account" && valuation.net == null ||
    pair.source === "manual" && valuation.unrealized == null
  ) return null;
  const assets = [pair.assetA, pair.assetB],
    points = assets.map((asset) => quotes[asset]),
    required = assets.map((asset, i) =>
      valuation.legs ? Number(valuation.legs[i].quantity) !== 0 : true
    );
  if (
    points.some((q, i) =>
      required[i] &&
      (!q || !Number.isFinite(q.time) || q.time > now || now - q.time > 15000 ||
        !Number.isFinite(Number(q.price)) || Number(q.price) <= 0)
    )
  ) return null;
  const requiredTimes = points.filter((q, i) => required[i]).map((q) => q.time);
  if (
    requiredTimes.length === 2 &&
    Math.abs(requiredTimes[0] - requiredTimes[1]) > 15000
  ) return null;
  return {
    time: now / 1000,
    priceA: points[0]?.price ?? null,
    priceB: points[1]?.price ?? null,
    observedA: points[0] ? points[0].time / 1000 : null,
    observedB: points[1] ? points[1].time / 1000 : null,
    live: true,
  };
}
