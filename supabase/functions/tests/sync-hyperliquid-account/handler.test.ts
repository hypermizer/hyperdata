import { assertEquals } from "@std/assert";
import { handleAccountSync } from "../../sync-hyperliquid-account/handler.ts";

const request = (secret = "secret", method = "POST") => new Request("https://example.test", {
  method, headers: { "x-monitor-secret": secret },
});

Deno.test("account sync rejects unauthorized and non-POST requests before claiming", async () => {
  let claims = 0;
  const dependencies = { schedulerSecret: "secret", claim: async () => { claims += 1; return null; }, sync: async () => ({ fills: 0 }) };
  assertEquals((await handleAccountSync(request("wrong"), dependencies)).status, 401);
  assertEquals((await handleAccountSync(request("secret", "GET"), dependencies)).status, 405);
  assertEquals(claims, 0);
});

Deno.test("account sync reports an empty queue without invoking sync", async () => {
  let syncs = 0;
  const response = await handleAccountSync(request(), {
    schedulerSecret: "secret", claim: async () => null, sync: async () => { syncs += 1; return { fills: 0 }; },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: "idle" });
  assertEquals(syncs, 0);
});

Deno.test("account sync processes the claimed source", async () => {
  const source = { user_id: "u", address: "0x1", fills_cursor_ms: null, funding_cursor_ms: null, ledger_cursor_ms: null };
  const response = await handleAccountSync(request(), {
    schedulerSecret: "secret", claim: async () => source, sync: async (claimed) => {
      assertEquals(claimed, source);
      return { fills: 7, funding: 2, ledger: 1, positions: 3 };
    },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: "succeeded", fills: 7, funding: 2, ledger: 1, positions: 3 });
});
