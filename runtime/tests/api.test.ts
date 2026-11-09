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
