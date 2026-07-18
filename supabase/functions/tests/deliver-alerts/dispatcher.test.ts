import { assertEquals } from "@std/assert";
import { dispatchClaim } from "../../deliver-alerts/dispatcher.ts";
const context = { asset: "xyz:ORCL", detector: "fixed_price", markPrice: 100, classification: "fixed_price", evidence: {}, bucket: "2026-01-01T00:00:00Z" };
function clientWith(results: Array<{ data: boolean | null; error: { message: string } | null }>) {
  return { rpc: () => Promise.resolve(results.shift() ?? { data: true, error: null }) };
}
Deno.test("records confirmed delivery", async () => {
  const state = await dispatchClaim(clientWith([{ data: true, error: null }]) as never, { id: "o", occurrence_id: "x", channel: "email", attempts: 1 }, context, async () => ({ providerId: "p" }));
  assertEquals(state, "sent");
});
Deno.test("definite provider failure enters bounded retry", async () => {
  const state = await dispatchClaim(clientWith([{ data: true, error: null }]) as never, { id: "o", occurrence_id: "x", channel: "email", attempts: 1 }, context, async () => { throw new Error("provider rejected"); });
  assertEquals(state, "retry_wait");
});
Deno.test("provider acceptance plus recoverable database failure is recorded ambiguous", async () => {
  const state = await dispatchClaim(clientWith([{ data: null, error: { message: "database unavailable" } }, { data: true, error: null }]) as never,
    { id: "o", occurrence_id: "x", channel: "email", attempts: 1 }, context, async () => ({ providerId: "p" }));
  assertEquals(state, "ambiguous");
});
