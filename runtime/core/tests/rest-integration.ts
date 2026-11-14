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

Deno.test("comparison preferences persist privately and cannot be forged by another user", async () => {
  const settings = {
    assetA: "BTC",
    assetB: "xyz:GOLD",
    interval: "1h",
    window: 604800,
    mode: "percent",
    range: null,
  };
  let response = await call("comparison_preferences", token, "POST", {
    user_id: owner,
    settings,
  });
  assertEquals(response.status, 201);
  await response.body?.cancel();
  response = await call("comparison_preferences", token);
  assertEquals((await response.json())[0].settings, settings);
  const stranger = await signLocalToken(secret, {
    role: "authenticated",
    sub: "00000000-0000-0000-0000-000000000778",
    email: "stranger@example.com",
  });
  response = await call("comparison_preferences", stranger);
  assertEquals(await response.json(), []);
  response = await call("comparison_preferences", stranger, "POST", {
    user_id: owner,
    settings,
  });
  assertEquals(response.status, 403);
  await response.body?.cancel();
  response = await call(
    "comparison_preferences?user_id=eq." + owner,
    token,
    "PATCH",
    { settings: { ...settings, mode: "price" } },
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json())[0].settings.mode, "price");
  response = await call(
    "comparison_preferences?user_id=eq." + owner,
    token,
    "DELETE",
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
});

Deno.test('pair monitor persistence, private snapshots, history bounds and notification privileges',async()=>{
 const config={name:'REST pair',source:'manual',assetA:'BTC',assetB:'ETH',openedAt:Date.now()-10000,legs:[{side:'long',quantity:'1',entry:'100',leverage:2,marginMode:'isolated'},{side:'short',quantity:'2',entry:'50',leverage:2,marginMode:'isolated'}],costs:{fees:'0',funding:null,realized:'0'},alerts:{}};
 let r=await call('pair_trades',token,'POST',{user_id:owner,config});assertEquals(r.status,201);const id=(await r.json())[0].id;
 r=await call('pair_trades?id=eq.'+id,token);assertEquals((await r.json())[0].config,config);
 const stranger=await signLocalToken(secret,{role:'authenticated',sub:'00000000-0000-0000-0000-000000000778',email:'stranger@example.com'});
 r=await call('pair_trades',stranger);assertEquals(await r.json(),[]);
 r=await call('pair_trades',stranger,'POST',{user_id:owner,config});assertEquals(r.status,403);await r.body?.cancel();
 r=await call('rpc/pair_account_snapshot',token,'POST',{p_assets:['BTC','ETH']});assertEquals(r.status,200);const snapshot=await r.json();assert(Array.isArray(snapshot.fills));assert(Array.isArray(snapshot.live));
 r=await call('rpc/pair_account_snapshot',token,'POST',{p_assets:['BTC','ETH'],p_user:'00000000-0000-0000-0000-000000000778'});assertEquals(r.status,400);await r.body?.cancel();
 r=await call('rpc/pair_mark_history',token,'POST',{p_assets:['BTC','ETH'],p_start:new Date(Date.now()-3600000).toISOString(),p_end:new Date().toISOString(),p_interval:60});assertEquals(r.status,200);assertEquals((await r.json()).basis,'mark');
 r=await call('rpc/request_comparison_history',token,'POST',{p_asset:'xyz:NVDA',p_interval:'1m',p_start:1788286500000,p_end:1788286620000});assertEquals(r.status,200);const job=await r.json();assertEquals(job.state,'pending');
 r=await call('comparison_history_cache?key=eq.'+job.key,service,'PATCH',{state:'error',error:'Temporary failure',updated_at:new Date(Date.now()-60000).toISOString()});assertEquals(r.status,200);await r.body?.cancel();
 r=await call('rpc/request_comparison_history',token,'POST',{p_asset:'xyz:NVDA',p_interval:'1m',p_start:1788286500000,p_end:1788286620000});assertEquals((await r.json()).state,'error');
 r=await call('rpc/request_comparison_history',token,'POST',{p_asset:'xyz:NVDA',p_interval:'1m',p_start:1788286500000,p_end:1788286620000,p_retry:true});assertEquals((await r.json()).state,'pending');
 r=await call('comparison_history_cache?key=eq.'+job.key,token);assertEquals((await r.json()).length,1);
 r=await call('comparison_history_cache',stranger);assertEquals(await r.json(),[]);
 r=await call('rpc/request_comparison_history',token,'POST',{p_asset:'BTC',p_interval:'1m',p_start:null,p_end:1});assertEquals(r.status,400);await r.body?.cancel();
 r=await call('rpc/observe_pair_alert',token,'POST',{p_pair:id,p_metric:'profit',p_breached:true,p_message:'forbidden'});assertEquals(r.status,403);await r.body?.cancel();
 r=await call('rpc/claim_comparison_history',service,'POST',{});assertEquals(r.status,200);assertEquals((await r.json())[0].key,job.key);
 r=await call('pair_trades?id=eq.'+id,token,'PATCH',{config:{...config,name:'Updated REST pair'}});assertEquals(r.status,200);assertEquals((await r.json())[0].config.name,'Updated REST pair');
 r=await call('pair_trades?id=eq.'+id,token,'PATCH',{archived:true});assertEquals(r.status,200);assertEquals((await r.json())[0].archived,true);
});

Deno.test('PAIR view selection, viewport and controls persist privately across requests',async()=>{
 const settings={assetA:'xyz:NVDA',assetB:'xyz:AMD',selectedPairId:null,selectionSet:true,period:'6h',sampling:15,follow:false,ranges:{'00000000-0000-0000-0000-000000000123':{from:1794613000,to:1794616600}}};
 let r=await call('pair_view_preferences',token,'POST',{user_id:owner,settings});assertEquals(r.status,201);await r.body?.cancel();r=await call('pair_view_preferences',token);assertEquals((await r.json())[0].settings,settings);
 const stranger=await signLocalToken(secret,{role:'authenticated',sub:'00000000-0000-0000-0000-000000000778',email:'stranger@example.com'});r=await call('pair_view_preferences',stranger);assertEquals(await r.json(),[]);r=await call('pair_view_preferences',stranger,'POST',{user_id:owner,settings});assertEquals(r.status,403);await r.body?.cancel();
 r=await call('pair_view_preferences?user_id=eq.'+owner,token,'PATCH',{settings:{...settings,sampling:60}});assertEquals(r.status,200);assertEquals((await r.json())[0].settings.sampling,60);
});
