import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLiveMarketContext,
  buildPriceChangeSignals,
  fetchAverageDailyVolume,
  fetchDexNames,
  fetchMarketsForDex,
  fetchPriceHistory,
  postInfo,
} from "../public/lib/hyperliquid.js";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("postInfo sends the expected Hyperliquid request", async () => {
  let request;
  const result = await postInfo({ type: "perpDexs" }, async (url, options) => {
    request = { url, options };
    return jsonResponse([null, { name: "xyz" }]);
  });
  assert.equal(request.url, "https://api.hyperliquid.xyz/info");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { type: "perpDexs" });
  assert.equal(result[1].name, "xyz");
});

test("postInfo surfaces non-success responses", async () => {
  await assert.rejects(
    () => postInfo({ type: "perpDexs" }, async () => jsonResponse({}, 429)),
    /returned 429/,
  );
});

test("fetchDexNames includes the default perp dex", async () => {
  const names = await fetchDexNames(async () =>
    jsonResponse([null, { name: "xyz" }, { name: "flx" }]),
  );
  assert.deepEqual(names, ["", "xyz", "flx"]);
});

test("fetchMarketsForDex combines metadata and market context", async () => {
  const fetchImpl = async () =>
    jsonResponse([
      { universe: [{ name: "xyz:ORCL", maxLeverage: 10 }] },
      [{ markPx: "250", prevDayPx: "200", dayNtlVlm: "1000", openInterest: "20", funding: "0.0001" }],
    ]);
  const [market] = await fetchMarketsForDex("xyz", fetchImpl);
  assert.deepEqual(market, {
    id: "xyz:ORCL",
    symbol: "ORCL",
    dex: "xyz",
    dexId: "xyz",
    markPrice: 250,
    previousPrice: 200,
    changePercent: 25,
    volume24h: 1000,
    openInterest: 20,
    funding: 0.0001,
    maxLeverage: 10,
    isDelisted: false,
  });
});

test("applyLiveMarketContext replaces a market's live stats from the WebSocket feed", () => {
  const updated = applyLiveMarketContext(
    {
      id: "xyz:ORCL",
      markPrice: 125,
      previousPrice: 120,
      changePercent: 4.17,
      volume24h: 1000,
      openInterest: 10,
    },
    {
      markPx: "126.88",
      prevDayPx: "126.01",
      dayNtlVlm: "14367445.938",
      openInterest: "225972.12",
    },
  );

  assert.equal(updated.id, "xyz:ORCL");
  assert.equal(updated.markPrice, 126.88);
  assert.equal(updated.previousPrice, 126.01);
  assert.ok(Math.abs(updated.changePercent - 0.6904213951273654) < 0.000001);
  assert.equal(updated.volume24h, 14367445.938);
  assert.equal(updated.openInterest, 225972.12);
});

test("fetchAverageDailyVolume estimates trailing daily notional volume from candles", async () => {
  let request;
  const result = await fetchAverageDailyVolume(
    "xyz:ORCL",
    async (_url, options) => {
      request = JSON.parse(options.body);
      return jsonResponse([
        { c: "100", v: "10" },
        { c: "120", v: "20" },
        { c: "80", v: "30" },
      ]);
    },
    Date.UTC(2026, 6, 17),
  );

  assert.equal(request.type, "candleSnapshot");
  assert.deepEqual(request.req, {
    coin: "xyz:ORCL",
    interval: "1d",
    startTime: Date.UTC(2026, 5, 17),
    endTime: Date.UTC(2026, 6, 17),
  });
  assert.equal(result, 5800 / 3);
});

test("fetchPriceHistory requests compact hourly and five-minute snapshots", async () => {
  const now = Date.UTC(2026, 6, 17, 12);
  const requests = [];
  const points = await fetchPriceHistory(
    "xyz:ORCL",
    async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return jsonResponse([{ T: now - 300_000, c: "100" }]);
    },
    now,
  );

  assert.deepEqual(requests, [
    {
      type: "candleSnapshot",
      req: {
        coin: "xyz:ORCL",
        interval: "1h",
        startTime: now - (7 * 24 * 60 * 60 * 1000) - (60 * 60 * 1000),
        endTime: now,
      },
    },
    {
      type: "candleSnapshot",
      req: {
        coin: "xyz:ORCL",
        interval: "5m",
        startTime: now - (24 * 60 * 60 * 1000) - (5 * 60 * 1000),
        endTime: now,
      },
    },
  ]);
  assert.deepEqual(points, [{ time: now - 300_000, price: 100 }]);
});

test("buildPriceChangeSignals returns ordered changes across all seven intervals", () => {
  const now = Date.UTC(2026, 6, 17, 12);
  const signals = buildPriceChangeSignals(120, [
    { time: now - (7 * 24 * 60 * 60 * 1000), price: 90 },
    { time: now - (24 * 60 * 60 * 1000), price: 100 },
    { time: now - (6 * 60 * 60 * 1000), price: 110 },
    { time: now - (60 * 60 * 1000), price: 115 },
    { time: now - (30 * 60 * 1000), price: 116 },
    { time: now - (15 * 60 * 1000), price: 117 },
    { time: now - (10 * 60 * 1000), price: 118 },
    { time: now - (5 * 60 * 1000), price: 119 },
  ], now);

  assert.deepEqual(signals.map(({ label }) => label), ["1w", "1d", "6h", "1h", "30m", "10m", "5m"]);
  assert.deepEqual(signals.map(({ direction }) => direction), ["up", "up", "up", "up", "up", "up", "up"]);
  assert.deepEqual(signals.map(({ referencePrice }) => referencePrice), [90, 100, 110, 115, 116, 118, 119]);
  assert.ok(Math.abs(signals[0].changePercent - (120 / 90 - 1) * 100) < 0.000001);
  assert.ok(Math.abs(signals[3].changePercent - (120 / 115 - 1) * 100) < 0.000001);
  assert.ok(signals.every(({ intensity }) => ["light", "medium", "strong"].includes(intensity)));
});
