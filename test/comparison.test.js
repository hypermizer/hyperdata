import test from "node:test";
import assert from "node:assert/strict";
import { anchoredComparisonModel, candleEnd, comparisonModel, comparisonPreferences, comparisonSeries, entryStartAnchor, intervalForStart, latestTradeQuote, marketStartAnchor, parseComparisonStart } from "../public/lib/comparison.js";
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

test("the chosen UTC start is parsed without browser timezone shifts or invalid dates", () => {
  assert.equal(parseComparisonStart("2026-11-01T01:30"), Date.UTC(2026, 10, 1, 1, 30) / 1000);
  assert.equal(parseComparisonStart("2026-11-01T01:30:22"), Date.UTC(2026, 10, 1, 1, 30, 22) / 1000);
  assert.equal(parseComparisonStart("2026-02-30T12:00"), null);
  assert.equal(parseComparisonStart("2026-11-01T01:30-05:00"), null);
});

test("market entry uses exactly the shared completed minute ending at the selected start", () => {
  const settings = { startTime: start, assetA: "BTC", assetB: "ETH" };
  const anchor = marketStartAnchor([bar(start - 60, 100), bar(start, 999)], [bar(start - 60, 200), bar(start, 999)], settings);
  assert.equal(anchor.time, start); assert.equal(anchor.priceA, 100); assert.equal(anchor.priceB, 200);
  assert.throws(() => marketStartAnchor([bar(start - 120, 99)], [bar(start - 60, 200)], settings), /unavailable/);
  assert.throws(() => marketStartAnchor([], [], { ...settings, startTime: start + 5 }), /full UTC minutes/);
});

test("both fixed-start lines begin at zero, exclude pre-start data, and timestamp closed candles correctly", () => {
  const anchor = entryStartAnchor({ startTime: start, assetA: "BTC", assetB: "ETH", entryA: 100, entryB: 200 });
  const model = anchoredComparisonModel([bar(start - 120, 999), bar(start, 110)], [bar(start - 120, 999), bar(start, 190)], { anchor, interval: "1m", to: start + 90 });
  assert.equal(model.rows[0].time, start); assert.equal(model.rows[0].returnA, 0); assert.equal(model.rows[0].returnB, 0);
  assert.equal(model.rows[1].time, start + 60);
  assert.ok(Math.abs(model.rows[1].returnA - 10) < 1e-10); assert.ok(Math.abs(model.rows[1].returnB + 5) < 1e-10);
  assert.ok(model.rows.every((row) => row.time >= start));
});

test("live trade returns update immediately against the original fills without using a future candle close", () => {
  const anchor = entryStartAnchor({ startTime: start, assetA: "BTC", assetB: "ETH", entryA: 100, entryB: 200 });
  const live = [{ time: start + 85, price: 104, source: "trade" }, { time: start + 70, price: 190, source: "trade" }];
  const model = anchoredComparisonModel([bar(start + 60, 999)], [bar(start + 60, 999)], { anchor, interval: "1m", to: start + 90, live });
  const row = model.rows.at(-1); assert.equal(row.time, start + 90); assert.equal(row.live, true);
  assert.ok(Math.abs(row.returnA - 4) < 1e-10); assert.ok(Math.abs(row.returnB + 5) < 1e-10);
  assert.equal(model.rows.length, 2);
  const coarse = anchoredComparisonModel([], [], { anchor, interval: "1h", to: start + 90, live });
  assert.equal(coarse.rows.at(-1).returnA, row.returnA); assert.equal(coarse.rows.at(-1).returnB, row.returnB);
});

test("a missing leg does not block the other leg or fabricate a historical price", () => {
  const anchor = { time: start, priceA: 100, priceB: 200 };
  const model = anchoredComparisonModel([bar(start, 110)], [], { anchor, interval: "1m", to: start + 90, live: [{ time: start + 85, price: 115 }] });
  const [a, b] = comparisonSeries(model);
  assert.ok(a.at(-1).value > 14.99); assert.deepEqual(b.at(-1), { time: start + 90 });
  assert.equal(model.rows[1].priceB, undefined);
});

test("fixed baseline, fill prices and follow mode survive serialization and reject stale pair anchors", () => {
  const settings = comparisonPreferences({ assetA: "BTC", assetB: "ETH", startTime: start, basis: "entry", entryA: 100, entryB: 200, mode: "price", followNow: false });
  settings.anchor = entryStartAnchor(settings);
  assert.deepEqual(comparisonPreferences(JSON.parse(JSON.stringify(settings))), settings);
  assert.equal(settings.mode, "percent");
  assert.equal(comparisonPreferences({ ...settings, assetB: "xyz:GOLD" }).anchor, null);
  assert.equal(comparisonPreferences({ ...settings, entryA: 101 }).anchor, null);
  assert.throws(() => entryStartAnchor({ entryA: 0, entryB: 200 }), /positive fill price/);
});

test("longer fixed-start histories increase sampling interval rather than silently truncate the start", () => {
  assert.equal(intervalForStart("1m", start, start + 8 * 86400), "3m");
  assert.equal(intervalForStart("1h", start, start + 86400), "1h");
});

test("live trade data rejects other venues, out-of-order values, invalid prices and future timestamps", () => {
  const previous = { price: 100, time: start + 50, source: "trade" };
  for (const trade of [
    { coin: "xyz:BTC", px: "110", time: (start + 60) * 1000 },
    { coin: "BTC", px: "110", time: (start + 40) * 1000 },
    { coin: "BTC", px: "NaN", time: (start + 60) * 1000 },
    { coin: "BTC", px: "110", time: (start + 6000) * 1000 },
  ]) assert.equal(latestTradeQuote(previous, trade, "BTC", start, start + 90), previous);
  const next = latestTradeQuote(previous, { coin: "BTC", px: "111", time: (start + 60) * 1000 }, "BTC", start, start + 90);
  assert.equal(next.price, 111); assert.equal(next.time, start + 60);
});

test('September 1 hourly fallback is explicit, timestamp-exact, persistent, and never substitutes a minute baseline',()=>{
 const time=Date.UTC(2026,8,1)/1000,settings=comparisonPreferences({assetA:'xyz:NVDA',assetB:'xyz:AMD',startTime:time,basis:'hourly'});
 const anchor=marketStartAnchor([bar(time-3600,100)],[bar(time-3600,200)],settings);
 assert.equal(anchor.time,time);assert.equal(anchor.source,'1h_close');assert.equal(anchor.basis,'hourly');
 assert.deepEqual(comparisonPreferences({...settings,anchor}).anchor,anchor);
 assert.throws(()=>marketStartAnchor([bar(time-3600,100)],[bar(time-3600,200)],{...settings,basis:'market'}),/unavailable/);
 assert.throws(()=>marketStartAnchor([bar(time-3600,100)],[bar(time-3600,200)],{...settings,startTime:time+60}),/UTC/);
});
