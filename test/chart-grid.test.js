import test from "node:test";
import assert from "node:assert/strict";
import { chartRequest, chartWindows, fetchChartCandles, moveChart, normalizeChartPreferences, orderedChartAssets } from "../public/lib/chart-grid.js";

test("persisted grid settings restore and malformed values cannot break layout", () => {
  const settings = normalizeChartPreferences({ interval: "5m", window: 86400, columns: 4, rows: 3, height: 350, order: ["ETH", "BTC", "ETH"], ranges: { BTC: { from: 100, to: 200 }, ETH: { from: 200, to: 100 } } });
  assert.deepEqual(normalizeChartPreferences(JSON.parse(JSON.stringify(settings))), settings);
  assert.deepEqual(settings.order, ["ETH", "BTC"]);
  assert.deepEqual(settings.ranges, { BTC: { from: 100, to: 200 } });
  assert.equal(normalizeChartPreferences({ columns: 500, rows: -1, height: 0 }).columns, 6);
  assert.equal(normalizeChartPreferences({ rows: -1 }).rows, 1);
  assert.equal(normalizeChartPreferences(null).interval, "1h");
});

test("candle intervals and visible windows always fit the provider history limit", () => {
  for (const interval of ["1m", "5m", "1h", "1d", "1w", "1M"]) {
    for (const window of chartWindows(interval)) {
      const prefs = normalizeChartPreferences({ interval, window: window.seconds });
      const request = chartRequest(prefs, 1800000000000);
      assert.ok(request.count <= 4900 && request.count >= 4);
      assert.ok(request.startTime > 0 && request.startTime < request.endTime);
    }
  }
  assert.equal(normalizeChartPreferences({ interval: "1m", window: 31536000 }).window, 259200);
});

test("dragged order survives refresh, removes unwatched assets and appends new watches", () => {
  const order = moveChart(["BTC", "ETH", "xyz:GOLD"], "xyz:GOLD", "BTC");
  assert.deepEqual(order, ["xyz:GOLD", "BTC", "ETH"]);
  assert.deepEqual(orderedChartAssets(["ETH", "xyz:GOLD", "SOL", "SOL"], JSON.parse(JSON.stringify(order))), ["xyz:GOLD", "ETH", "SOL"]);
  assert.deepEqual(moveChart(order, "BAD", "BTC"), order);
});

test("chart history uses the exact venue and interval, bounds reads and normalizes real candles", async () => {
  const now = 1800000000000, prefs = normalizeChartPreferences({ interval: "5m", window: 86400 });
  const bars = await fetchChartCandles("xyz:GOLD", prefs, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.req.coin, "xyz:GOLD"); assert.equal(body.req.interval, "5m");
    assert.ok(body.req.startTime >= now - 2 * 86400000);
    return Response.json([{ t: now - 300000, o: "100", h: "105", l: "99", c: "103", v: "20", n: 3 }, { t: "bad" }]);
  }, now);
  assert.equal(bars.length, 1); assert.equal(bars[0].close, 103); assert.equal(bars[0].time, (now - 300000) / 1000);
});
