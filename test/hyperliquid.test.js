import assert from "node:assert/strict";
import test from "node:test";
import {
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
