import assert from "node:assert/strict";
import test from "node:test";
import { applyAssetAnalyticsRows, earliestIsoTimestamp, recordLivePricePoint } from "../public/lib/asset-analytics.js";

test("a bulk analytics response hydrates every asset without replacing newer live points", () => {
  const averageVolumes = new Map();
  const firstSeenAt = new Map();
  const priceHistories = new Map([
    ["xyz:ORCL", [{ time: 200, price: 102 }]],
  ]);

  const count = applyAssetAnalyticsRows([
    { asset: "xyz:ORCL", average_daily_volume: 50_000, first_seen_at: "2026-08-01T12:00:00Z", price_history: [{ time: 100, price: 100 }] },
    { asset: "xyz:XYZ100", average_daily_volume: 75_000, price_history: [{ time: 100, price: 200 }] },
  ], { averageVolumes, firstSeenAt, priceHistories });

  assert.equal(count, 2);
  assert.equal(averageVolumes.get("xyz:ORCL"), 50_000);
  assert.equal(firstSeenAt.get("xyz:ORCL"), "2026-08-01T12:00:00.000Z");
  assert.deepEqual(priceHistories.get("xyz:ORCL"), [
    { time: 100, price: 100 },
    { time: 200, price: 102 },
  ]);
  assert.deepEqual(priceHistories.get("xyz:XYZ100"), [{ time: 100, price: 200 }]);
});

test("bulk analytics ignores malformed values", () => {
  const averageVolumes = new Map();
  const priceHistories = new Map();

  assert.equal(applyAssetAnalyticsRows([
    { asset: "", average_daily_volume: 1, price_history: [] },
    { asset: "xyz:ORCL", average_daily_volume: -1, price_history: [{ time: "bad", price: 100 }] },
  ], { averageVolumes, priceHistories }), 1);
  assert.equal(averageVolumes.has("xyz:ORCL"), false);
  assert.deepEqual(priceHistories.get("xyz:ORCL"), []);
});

test("a live price tick retains enough history for 20-session volatility", () => {
  const now = Date.UTC(2026, 7, 5, 21, 23);
  const points = Array.from({ length: 31 }, (_, day) => ({
    time: now - ((30 - day) * 24 * 60 * 60 * 1000),
    price: 100 + day,
  }));

  const updated = recordLivePricePoint(points, 131, now);

  assert.equal(updated.length, 31);
  assert.equal(updated[0].time, points[0].time);
  assert.deepEqual(updated.at(-1), {
    time: now,
    price: 131,
  });
});

test("historical discovery repairs a newer cached first-seen timestamp", () => {
  assert.equal(
    earliestIsoTimestamp("2026-08-28T00:00:00Z", "2026-06-01T00:00:00Z"),
    "2026-06-01T00:00:00.000Z",
  );
  assert.equal(earliestIsoTimestamp(undefined, "invalid"), null);
});

test("an open page merges repaired references with its newer streamed prices", async () => {
  const {buildPriceChangeSignals}=await import("../public/lib/hyperliquid.js");
  const now=Date.now(),averageVolumes=new Map(),priceHistories=new Map();
  priceHistories.set("BTC",recordLivePricePoint([],105,now));
  assert.equal(buildPriceChangeSignals(105,priceHistories.get("BTC"),now).filter(s=>s.referencePrice===null).length,7);
  const windows=[7*86400000,86400000,6*3600000,3600000,1800000,600000,300000];
  applyAssetAnalyticsRows([{asset:"BTC",price_history:windows.map(time=>({time:now-time,price:100})).sort((a,b)=>a.time-b.time)}],{averageVolumes,priceHistories});
  assert.equal(buildPriceChangeSignals(105,priceHistories.get("BTC"),now).filter(s=>s.referencePrice===null).length,0);
  assert.equal(priceHistories.get("BTC").at(-1).price,105);
});


test("live ticks retain actual timestamps and chronological server samples", () => {
  const now=Date.UTC(2026,10,9,23,13,42);
  const server=[{time:now-115000,price:100},{time:now-55000,price:101}];
  const updated=recordLivePricePoint(server,102,now);
  assert.deepEqual(updated,[...server,{time:now,price:102}]);
  const next=recordLivePricePoint(updated,103,now+1000);
  assert.deepEqual(next,[...server,{time:now+1000,price:103}]);
  assert.ok(next.every((point,i)=>i===0||point.time>next[i-1].time));
});
