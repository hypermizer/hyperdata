import { assert, assertEquals } from "@std/assert";
import {
  localDataFetch,
  signLocalToken,
} from "../../../supabase/functions/_shared/local-data.ts";
const socket = Deno.env.get("TEST_CORE_SOCKET")!,
  secret = Deno.env.get("TEST_CORE_SECRET")!;
const owner = "00000000-0000-0000-0000-000000000777",
  email = "jasonblick@zohomail.com";
const f = localDataFetch(socket);
const service = await signLocalToken(secret, { role: "service_role" });
const token = await signLocalToken(secret, {
  role: "authenticated",
  sub: owner,
  email,
});
async function call(
  path: string,
  identity: string,
  method = "GET",
  body?: unknown,
) {
  return await f("http://local-data/rest/v1/" + path, {
    method,
    headers: {
      authorization: "Bearer " + identity,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
Deno.test("local REST preserves RLS, financial RPCs, empty DELETE, and forged-token denial", async () => {
  let r = await call("watchlist_items", "invalid");
  assertEquals(r.status, 401);
  await r.body?.cancel();
  r = await call("watchlist_items", token, "POST", {
    user_id: owner,
    asset: "BTC",
  });
  assertEquals(r.status, 201);
  await r.body?.cancel();
  r = await call("watchlist_items?asset=eq.BTC", token);
  assertEquals((await r.json()).length, 1);
  r = await call("watchlist_items", token, "POST", {
    user_id: "00000000-0000-0000-0000-000000000778",
    asset: "ETH",
  });
  assertEquals(r.status, 403);
  await r.body?.cancel();
  r = await call("watchlist_items?asset=eq.BTC", token, "DELETE");
  assertEquals(r.status, 200);
  await r.body?.cancel();
  r = await call("rpc/create_paper_account", token, "POST", {
    p_name: "REST validation",
    p_starting_capital: 12345,
  });
  assertEquals(r.status, 200);
  const id = await r.json();
  assert(typeof id === "string");
  r = await call("paper_accounts?id=eq." + id, token);
  assertEquals((await r.json()).length, 1);
  const stranger = await signLocalToken(secret, {
    role: "authenticated",
    sub: "00000000-0000-0000-0000-000000000778",
    email: "stranger@example.com",
  });
  r = await call("paper_accounts", stranger);
  assertEquals((await r.json()).length, 0);
  r = await call("rpc/apply_paper_effects", token, "POST", {
    p_account_id: id,
    p_epoch_number: 1,
    p_expected_version: 0,
    p_idempotency_key: "forbidden",
    p_effects: {},
  });
  assertEquals(r.status, 403);
  await r.body?.cancel();
  r = await call("paper_accounts", service);
  assertEquals((await r.json()).length, 1);
});

Deno.test("chart preferences persist through REST and are isolated to the owner", async () => {
  const settings = {
    interval: "5m",
    window: 86400,
    columns: 4,
    rows: 2,
    height: 350,
    order: ["ETH", "BTC"],
    ranges: {},
  };
  let response = await call("chart_grid_preferences", token, "POST", {
    user_id: owner,
    settings,
  });
  assertEquals(response.status, 201);
  await response.body?.cancel();
  response = await call("chart_grid_preferences", token);
  assertEquals((await response.json())[0].settings, settings);
  const stranger = await signLocalToken(secret, {
    role: "authenticated",
    sub: "00000000-0000-0000-0000-000000000778",
    email: "stranger@example.com",
  });
  response = await call("chart_grid_preferences", stranger);
  assertEquals(await response.json(), []);
  response = await call("chart_grid_preferences", stranger, "POST", {
    user_id: owner,
    settings,
  });
  assertEquals(response.status, 403);
  await response.body?.cancel();
  response = await call(
    "chart_grid_preferences?user_id=eq." + owner,
    token,
    "PATCH",
    { settings: { ...settings, columns: 2 } },
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json())[0].settings.columns, 2);
  response = await call(
    "chart_grid_preferences?user_id=eq." + owner,
    token,
    "DELETE",
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
});
