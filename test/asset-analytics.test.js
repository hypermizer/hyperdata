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
    time: Math.floor(now / 300_000) * 300_000,
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
