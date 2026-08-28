import test from "node:test";
import assert from "node:assert/strict";
import { getAssetMarketCatalog, getMarketCatalog, requireAssetUniverseDexes } from "../public/lib/market-catalog.js";

test("asset catalog requires both native crypto and TradFi markets", () => {
  const complete = [{ id: "BTC", dexId: "" }, { id: "xyz:ORCL", dexId: "xyz" }];
  assert.equal(requireAssetUniverseDexes(complete), complete);
  assert.throws(
    () => requireAssetUniverseDexes([{ id: "BTC", dexId: "" }]),
    /TradFi catalog unavailable/,
  );
  assert.throws(
    () => requireAssetUniverseDexes([{ id: "xyz:ORCL", dexId: "xyz" }]),
    /native crypto catalog unavailable/,
  );
});

test("asset catalog retries incomplete results without changing the shared partial catalog", async () => {
  const originalFetch = globalThis.fetch;
  let attempt = 0;

  globalThis.fetch = async (_url, { body }) => {
    const { type, dex } = JSON.parse(body);
    if (type === "perpDexs") {
      attempt += 1;
      return jsonResponse([{ name: "xyz" }]);
    }
    if (type === "perpConciseAnnotations") return jsonResponse([]);
    if (type === "metaAndAssetCtxs" && dex === "xyz" && attempt !== 2) {
      throw new Error("XYZ unavailable");
    }
    const name = dex === "xyz" ? "xyz:ORCL" : "BTC";
    return jsonResponse([
      { universe: [{ name, maxLeverage: 20, szDecimals: 2 }] },
      [{}],
    ]);
  };

  try {
    await assert.rejects(getAssetMarketCatalog(), /TradFi catalog unavailable/);
    assert.deepEqual((await getAssetMarketCatalog()).map(({ id }) => id), ["BTC", "xyz:ORCL"]);
    assert.deepEqual((await getMarketCatalog()).map(({ id }) => id), ["BTC"]);
    assert.equal(attempt, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}
