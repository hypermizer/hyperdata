import { assertEquals } from "@std/assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPending } from "../../deliver-alerts/service.ts";

Deno.test("a broken email claim cannot block iPhone delivery or finalization", async () => {
  Deno.env.set("NTFY_BASE_URL", "https://ntfy.sh"); Deno.env.set("NTFY_TOPIC", "test-topic");
  const oldFetch = globalThis.fetch;
  const finalized: string[] = [];
  globalThis.fetch = (() => Promise.resolve(Response.json({ event: "message", id: "ntfy-id" }))) as typeof fetch;
  const client = {
    rpc: (name: string, params: Record<string, unknown>) => {
      if (name === "claim_outbox") return Promise.resolve({ data: [
        { id: "email-row", occurrence_id: "broken", channel: "email", attempts: 1 },
        { id: "ntfy-row", occurrence_id: "ok", channel: "ntfy", attempts: 1 },
      ], error: null });
      finalized.push(String(params.p_id));
      assertEquals(params.p_attempt, 1);
      return Promise.resolve({ data: true, error: null });
    },
    from: () => ({ select: () => ({ eq: (_key: string, value: string) => ({ single: () => Promise.resolve(value === "broken"
      ? { data: null, error: { message: "missing row" } }
      : { data: { asset: "BTC", detector: "fixed_price", mark_price: 100, evidence: {}, bucket: new Date().toISOString() }, error: null }) }) }) }),
  } as unknown as SupabaseClient;
  try {
    const rows = await deliverPending(client);
    assertEquals(rows.map((row) => row.state), ["claimed", "sent"]);
    assertEquals(finalized, ["ntfy-row"]);
  } finally { globalThis.fetch = oldFetch; Deno.env.delete("NTFY_BASE_URL"); Deno.env.delete("NTFY_TOPIC"); }
});
