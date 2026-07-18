import { assertEquals } from "@std/assert";
import { authorizeInternal } from "../../_shared/auth.ts";
Deno.test("internal calls require the exact scheduler secret", () => {
  assertEquals(authorizeInternal(new Request("https://example.test"), "secret")?.status, 401);
  assertEquals(authorizeInternal(new Request("https://example.test", { headers: { "x-monitor-secret": "wrong" } }), "secret")?.status, 401);
  assertEquals(authorizeInternal(new Request("https://example.test", { headers: { "x-monitor-secret": "secret" } }), "secret"), null);
});
