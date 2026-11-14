import test from "node:test";
import assert from "node:assert/strict";
import { candleEnd, comparisonModel, comparisonPreferences, comparisonSeries } from "../public/lib/comparison.js";
const hour = 3600, start = 1800000000;
const bar = (time, close) => ({ time, close });

test("both returns use the first shared completed candle, including later listings", () => {
  const model = comparisonModel([bar(start, 50), bar(start + hour, 100), bar(start + 2 * hour, 110)], [bar(start + hour, 200), bar(start + 2 * hour, 180)], { to: start + 3 * hour, from: start });
  assert.equal(model.baseline.time, start + hour);
  const latest = model.rows.at(-1);
  assert.ok(Math.abs(latest.returnA - 10) < 1e-10); assert.ok(Math.abs(latest.returnB + 10) < 1e-10);
  assert.deepEqual(comparisonSeries(model, "price")[0].at(-1), { time: start + 2 * hour, value: 110 });
});

test("forming candles cannot establish the baseline and invalid prices are excluded", () => {
  const model = comparisonModel([bar(start, 0), bar(start + hour, 100)], [bar(start, NaN), bar(start + hour, 200)], { to: start + hour + 5 });
  assert.equal(model.baseline, null);
  const valid = comparisonModel([bar(start, 100), bar(start + hour, 110)], [bar(start, 200), bar(start + hour, 210)], { to: start + hour + 5 });
  assert.equal(valid.baseline.time, start); assert.equal(valid.rows.at(-1).forming, true);
});

test("missing and jointly absent candles remain gaps rather than carried-forward prices", () => {
  const model = comparisonModel([bar(start, 100), bar(start + hour, 110), bar(start + 4 * hour, 120)], [bar(start, 200), bar(start + 4 * hour, 240)], { to: start + 5 * hour });
  const [a, b] = comparisonSeries(model);
  assert.equal(a[0].color, "transparent"); assert.equal(b[0].color, "transparent");
  assert.equal(a.at(-1).color, undefined);
  assert.deepEqual(a[1], { time: start + hour }); assert.deepEqual(b[1], { time: start + hour });
  assert.deepEqual(a[2], { time: start + 2 * hour });
  assert.equal(model.gaps, 2);
});

test("live changes preserve the original baseline and align both values to one timestamp", () => {
  const a = [bar(start, 100), bar(start + hour, 105)];
  const b = [bar(start, 200), bar(start + hour, 210)];
  const first = comparisonModel(a, b, { to: start + 2 * hour });
  const live = comparisonModel([...a, bar(start + 2 * hour, 110)], b, { baselineTime: first.baseline.time, to: start + 2 * hour + 10 });
  assert.equal(live.baseline.time, start); assert.equal(live.rows.at(-1).priceA, undefined);
  const paired = comparisonModel([...a, bar(start + 2 * hour, 110)], [...b, bar(start + 2 * hour, 220)], { baselineTime: start, to: start + 2 * hour + 10 });
  assert.ok(Math.abs(paired.rows.at(-1).returnA - paired.rows.at(-1).returnB) < 1e-10);
});

test("panning into earlier history does not silently change the requested baseline", () => {
  const model = comparisonModel([bar(start, 90), bar(start + hour, 100)], [bar(start, 180), bar(start + hour, 200)], { from: start, baselineFrom: start + hour, to: start + 3 * hour });
  assert.equal(model.baseline.time, start + hour);
  assert.ok(Math.abs(model.rows[0].returnA + 10) < 1e-10);
});

test("settings preserve exact venues, mode and viewport and reject malformed persisted data", () => {
  const settings = comparisonPreferences({ assetA: "xyz:NVDA", assetB: "para:NVDA", interval: "5m", window: 86400, mode: "price", range: { from: start, to: start + hour } });
  assert.deepEqual(comparisonPreferences(JSON.parse(JSON.stringify(settings))), settings);
  assert.equal(comparisonPreferences({ interval: "bad", assetA: "<script>" }).assetA, "BTC");
  assert.equal(comparisonPreferences({ range: { from: 10, to: 1 } }).range, null);
  assert.equal(comparisonPreferences(null).mode, "percent");
});

test("monthly candle completion follows calendar months rather than a fixed 30-day estimate", () => {
  const february = Date.UTC(2026, 1, 1) / 1000;
  assert.equal(candleEnd(february, "1M"), Date.UTC(2026, 2, 1) / 1000);
});
