import { assertEquals, assertRejects } from "@std/assert";
import { sendNtfy } from "../../deliver-alerts/ntfy.ts";
Deno.test("ntfy publishes high-priority iPhone alert to existing private topic", async () => {
  const result = await sendNtfy({ baseUrl: "https://ntfy.sh", topic: "private-topic", token: "secret" }, { subject: "Price alert", text: "BTC at target" },
    ((_url: unknown, init: RequestInit) => {
      assertEquals(new Headers(init.headers).get("authorization"), "Bearer secret");
      assertEquals(JSON.parse(String(init.body)), { topic: "private-topic", title: "Price alert", message: "BTC at target", priority: 4,
        tags: ["chart_with_upwards_trend"], click: "https://hypermizer.github.io/hyperdata/#/alerts" });
      return Promise.resolve(Response.json({ event: "message", id: "accepted" }));
    }) as typeof fetch);
  assertEquals(result.providerId, "accepted");
});
Deno.test("ntfy failures do not reveal the private topic or provider response", async () => {
  await assertRejects(() => sendNtfy({ baseUrl: "https://ntfy.sh", topic: "secret" }, { subject: "a", text: "b" },
    (() => Promise.resolve(new Response("private details", { status: 429 }))) as typeof fetch), Error, "ntfy rejected notification (429)");
  await assertRejects(() => sendNtfy({ baseUrl: "https://ntfy.sh", topic: "secret" }, { subject: "a", text: "b" },
    (() => Promise.resolve(Response.json({}))) as typeof fetch), Error, "acceptance was not confirmed");
});
