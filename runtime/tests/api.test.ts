import { assertEquals, assertMatch } from "@std/assert";
import { alertApi } from "../api.ts";
const fingerprint = "A".repeat(40),
  owner = "00000000-0000-0000-0000-000000000001",
  origin = "https://192.0.2.10";
const store = {
  revoked: () => Promise.resolve(false),
  active: () => Promise.resolve(true),
  list: () => Promise.resolve({ rules: [], backend: "server" }),
  create: () => Promise.resolve({ id: "new" }),
  change: () => Promise.resolve({ id: "changed" }),
};
const base = {
  "x-hyperdata-verified": "SUCCESS",
  "x-hyperdata-certificate": fingerprint,
};
Deno.test("owner data is certificate-protected and write access requires CSRF for each configured private origin", async () => {
  let called = 0;
  const alternate = "https://dev-mini-ohio.tail628a67.ts.net:8446";
  const api = alertApi(store, {
    origin,
    additionalOrigins: [alternate],
    owner,
    ownerEmail: "owner@example.test",
    ownerBackend: () => {
      called++;
      return Promise.resolve(Response.json({ ok: true }));
    },
  });
  const path = origin + "/api/owner/rest/v1/watchlist_items";
  assertEquals((await api(new Request(path))).status, 403);
  const session = await (await api(
    new Request(origin + "/api/owner/session", { headers: base }),
  )).json();
  assertEquals(session.user.id, owner);
  assertEquals(session.user.email, "owner@example.test");
  const headers = {
    ...base,
    "content-type": "application/json",
    cookie: `__Host-hyperdata-csrf=${session.csrf}`,
    "x-csrf-token": session.csrf,
    origin: alternate,
  };
  assertEquals(
    (await api(
      new Request(path, { method: "POST", headers, body: '[{"asset":"BTC"}]' }),
    )).status,
    200,
  );
  assertEquals(
    (await api(
      new Request(path, {
        method: "POST",
        headers: { ...headers, origin: "https://hypermizer.github.io" },
        body: "[]",
      }),
    )).status,
    403,
  );
  assertEquals(called, 1);
  assertEquals(
    (await api(
      new Request(path + "?asset=eq.BTC", { method: "DELETE", headers }),
    )).status,
    200,
  );
  assertEquals(called, 2);
});
Deno.test("private API requires the verified client identity and rejects revoked certificates", async () => {
  const api = alertApi(store, { origin, owner });
  assertEquals((await api(new Request(origin + "/api/alerts"))).status, 403);
  assertEquals(
    (await alertApi({ ...store, revoked: () => Promise.resolve(true) }, {
      origin,
      owner,
    })(new Request(origin + "/api/alerts", { headers: base }))).status,
    403,
  );
});
Deno.test("CSRF cookie is host-only, secure, HTTP-only, and required with exact Origin", async () => {
  const api = alertApi(store, { origin, owner });
  const response = await api(
    new Request(origin + "/api/alerts/session", { headers: base }),
  );
  const { csrf } = await response.json();
  assertEquals(csrf.length, 72);
  assertMatch(
    response.headers.get("set-cookie")!,
    /Secure; HttpOnly; SameSite=Strict; Path=\//,
  );
  const body = JSON.stringify({
    asset: "BTC",
    detector: "fixed_price",
    configuration: { direction: "above", target: 100 },
  });
  const good = {
    ...base,
    origin,
    "content-type": "application/json",
    "x-csrf-token": csrf,
    cookie: `__Host-hyperdata-csrf=${csrf}`,
  };
  assertEquals(
    (await api(
      new Request(origin + "/api/alerts", {
        method: "POST",
        headers: { ...good, origin: "https://evil.example" },
        body,
      }),
    )).status,
    403,
  );
  assertEquals(
    (await api(
      new Request(origin + "/api/alerts", {
        method: "POST",
        headers: { ...good, "x-csrf-token": "" },
        body,
      }),
    )).status,
    403,
  );
  assertEquals(
    (await api(
      new Request(origin + "/api/alerts", {
        method: "POST",
        headers: good,
        body,
      }),
    )).status,
    201,
  );
  assertEquals(
    (await api(
      new Request(origin + "/api/alerts", {
        method: "POST",
        headers: good,
        body:
          '{"asset":"BTC","configuration":{"direction":"above","target":null}}',
      }),
    )).status,
    400,
  );
});
Deno.test("API does not fall back to Supabase or expose provider settings on a database failure", async () => {
  const api = alertApi({
    ...store,
    list: () => Promise.reject(new Error("private database detail")),
  }, { origin, owner });
  const r = await api(new Request(origin + "/api/alerts", { headers: base }));
  assertEquals(r.status, 503);
  assertEquals(await r.json(), { error: "Runtime temporarily unavailable." });
});
Deno.test("independent watchdog certificate can read health but cannot read or create alerts", async () => {
  const api = alertApi({
    ...store,
    health: () => Promise.resolve({ healthy: true }),
  }, {
    origin,
    owner,
    fingerprints: ["B".repeat(40)],
    healthFingerprints: [fingerprint],
  });
  assertEquals(
    (await api(new Request(origin + "/api/health", { headers: base }))).status,
    200,
  );
  assertEquals(
    (await api(new Request(origin + "/api/alerts", { headers: base }))).status,
    403,
  );
  assertEquals(
    (await api(new Request(origin + "/api/alerts/session", { headers: base })))
      .status,
    403,
  );
});

Deno.test("liquidation cache and collection demand require owner authentication and CSRF; health clients are excluded", async () => {
  let watched = 0;
  const api = alertApi(store, {
    origin,
    owner,
    healthFingerprints: ["B".repeat(40)],
    liquidations: {
      read: (asset) => Promise.resolve({ asset, latest: null, history: [] }),
      watch: () => {
        watched++;
        return Promise.resolve(true);
      },
    },
  });
  const url = origin + "/api/liquidations?asset=xyz%3AGOLD";
  assertEquals((await api(new Request(url))).status, 403);
  assertEquals(
    (await api(
      new Request(url, {
        headers: { ...base, "x-hyperdata-certificate": "B".repeat(40) },
      }),
    )).status,
    403,
  );
  const r = await api(new Request(url, { headers: base }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).asset, "xyz:GOLD");
  assertEquals(
    (await api(
      new Request(origin + "/api/liquidations?asset=..%2FBTC", {
        headers: base,
      }),
    )).status,
    400,
  );
  const body = JSON.stringify({ asset: "BTC", history: true });
  assertEquals(
    (await api(
      new Request(origin + "/api/liquidations/watch", {
        method: "POST",
        headers: { ...base, origin, "content-type": "application/json" },
        body,
      }),
    )).status,
    403,
  );
  const session = await (await api(
    new Request(origin + "/api/alerts/session", { headers: base }),
  )).json();
  const headers = {
    ...base,
    origin,
    "content-type": "application/json",
    "x-csrf-token": session.csrf,
    cookie: `__Host-hyperdata-csrf=${session.csrf}`,
  };
  assertEquals(
    (await api(
      new Request(origin + "/api/liquidations/watch", {
        method: "POST",
        headers,
        body,
      }),
    )).status,
    202,
  );
  assertEquals(watched, 1);
});
Deno.test("private health reports a local core failure without exposing account data", async () => {
  const api = alertApi({
    ...store,
    health: () => Promise.resolve({ healthy: true, backend: "local" }),
  }, {
    origin,
    owner,
    coreHealth: () =>
      Promise.resolve({
        healthy: false,
        historyFresh: false,
        markReferencesFresh: false,
        dotCoverage: null,
        referenceRepairsPending: null,
        watchedReferenceRepairsPending: null,
        paperFresh: true,
        accountSyncFresh: false,
        backend: "local",
      }),
  });
  const response = await api(
    new Request(origin + "/api/health", { headers: base }),
  );
  const data = await response.json();
  assertEquals(data.healthy, false);
  assertEquals(data.core.accountSyncFresh, false);
  assertEquals(Object.hasOwn(data.core, "accounts"), false);
});
