import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerTransport } from "../public/lib/owner-fetch.js";

test("temporary gateway failures retry watchlist reads with backoff", async () => {
  const waits = []; let calls = 0, clock = 10000;
  const transport = createOwnerTransport({ now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; }, fetchImpl: async () => { calls++; return calls < 3 ? new Response("retry", { status: 503 }) : Response.json([{ asset: "BTC" }]); } });
  const response = await transport("https://example.test/api/owner/rest/v1/watchlist_items");
  assert.deepEqual(await response.json(), [{ asset: "BTC" }]); assert.equal(calls, 3); assert.deepEqual(waits, [500, 1000]);
});

test("a financial command is never replayed after gateway or network failure", async () => {
  for (const failure of ["http", "network"]) {
    let calls = 0;
    const transport = createOwnerTransport({ fetchImpl: async () => { calls++; if (failure === "network") throw new TypeError("Network unavailable"); return new Response("unavailable", { status: 503 }); } });
    const request = transport("https://example.test/api/owner/functions/v1/paper-command", { method: "POST", body: "{}" });
    if (failure === "network") await assert.rejects(request); else assert.equal((await request).status, 503);
    assert.equal(calls, 1);
  }
});

test("startup owner reads are spaced below the gateway allowance", async () => {
  const dispatched = []; let clock = 10000;
  const transport = createOwnerTransport({ now: () => clock, wait: async (ms) => { clock += ms; }, fetchImpl: async () => { dispatched.push(clock); return Response.json([]); } });
  for (let index = 0; index < 10; index++) await transport("https://example.test/api/owner/rest/v1/watchlist_items");
  assert.equal(dispatched.length, 10);
  for (let index = 1; index < dispatched.length; index++) assert.ok(dispatched[index] - dispatched[index - 1] >= 125);
});
