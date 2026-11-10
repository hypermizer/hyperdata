import { assertEquals, assertRejects } from "@std/assert";
import { drainDeliveries, providerSender } from "../delivery.ts";
import { AlertStore, type LocalDelivery } from "../store.ts";

Deno.test("price delivery never invokes the email provider or claims email work", async () => {
  await assertRejects(
    async () =>
      await providerSender({ channel: "email" } as LocalDelivery, {
        subject: "test",
        text: "test",
      }),
    Error,
    "Email delivery is disabled",
  );
  const previous = Deno.env.get("DELIVERY_ENABLED");
  Deno.env.set("DELIVERY_ENABLED", "true");
  try {
    const channels: string[] = [];
    await drainDeliveries({
      claim: (channel: string) => {
        channels.push(channel);
        return Promise.resolve([]);
      },
    } as unknown as AlertStore);
    assertEquals(channels, ["ntfy"]);
  } finally {
    if (previous === undefined) Deno.env.delete("DELIVERY_ENABLED");
    else Deno.env.set("DELIVERY_ENABLED", previous);
  }
});
