import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLiveMarketContext,
  fetchAverageDailyVolume,
  fetchDexNames,
  fetchMarketsForDex,
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
