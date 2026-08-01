import assert from "node:assert/strict";
import test from "node:test";
import { fetchAssetFundamentals } from "../public/lib/fundamentals.js";

test("fundamentals client validates and caches normalized edge data", async () => {
  let calls = 0;
  const client = { functions: { invoke: async () => {
    calls += 1;
    return { data: { identity: { displayName: "Oracle Corporation", description: "Database company", yahooSymbol: "ORCL" }, currency: "USD", available: true, metrics: [], quarters: [] }, error: null };
  } } };
  const first = await fetchAssetFundamentals(client, "xyz:ORCL", 1);
  const second = await fetchAssetFundamentals(client, "xyz:ORCL", 2);
  assert.equal(first.identity.displayName, "Oracle Corporation");
  assert.equal(second.available, true);
  assert.equal(calls, 1);
});

test("fundamentals client rejects malformed service responses", async () => {
  const client = { functions: { invoke: async () => ({ data: { metrics: [] }, error: null }) } };
  await assert.rejects(() => fetchAssetFundamentals(client, "xyz:BAD", 1), /invalid data/i);
});
