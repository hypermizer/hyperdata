import { assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPending } from "../../deliver-alerts/service.ts";

Deno.test("delivery drain is safe to run inside every monitor cycle when the outbox is empty", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const client = {
    rpc: (name: string, parameters: Record<string, unknown>) => {
      calls.push({ name, parameters });
      return Promise.resolve({ data: [], error: null });
    },
  } as unknown as SupabaseClient;

  assertEquals(await deliverPending(client), []);
  assertEquals(calls, [{ name: "claim_outbox", parameters: { p_limit: 10 } }]);
});
