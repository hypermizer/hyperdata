import { assert, assertEquals } from "@std/assert";
import { AlertStore, type LocalDelivery } from "../store.ts";
import { deliverRow } from "../delivery.ts";
const owner = "00000000-0000-0000-0000-000000000001";
const store = new AlertStore({
  host: Deno.env.get("TEST_PGHOST") ?? "/tmp/hyperdata-runtime-pgtest",
  port: Number(Deno.env.get("TEST_PGPORT") ?? 5546),
  user: Deno.env.get("TEST_PGUSER") ?? "ubuntu",
  database: "postgres",
});
Deno.test("local transactions preserve one occurrence and independent, fenced channel deliveries", async () => {
  await store.migrate();
  await store
    .sql`truncate audit_events,notification_outbox,alert_occurrences,rule_evaluation_state,alert_rules restart identity cascade`;
  await store.setActive(true);
  const rule = await store.create(
    {
      asset: "xyz:GOLD",
      dex: "xyz",
      detector: "fixed_price",
      configuration: { direction: "above", target: 100 },
    },
    owner,
    "test",
  );
  const candidate = {
    key: rule.id,
    ruleId: rule.id,
    revision: rule.updated_at,
    asset: rule.asset,
    mark: 100,
    observedAt: new Date(Date.now() + 20).toISOString(),
  };
  assertEquals(await store.record({ ...candidate, mark: 99 }), null);
  assertEquals(await store.record({ ...candidate, asset: "BTC" }), null);
  assertEquals(
    await store.record({ ...candidate, revision: "2000-01-01T00:00:00Z" }),
    null,
  );
  const ids = await Promise.all([
    store.record(candidate),
    store.record(candidate),
  ]);
  assertEquals(ids.filter(Boolean).length, 1);
  assertEquals((await store.activeRules()).length, 0);
  const [phone, email] = await Promise.all([
    store.claim("ntfy"),
    store.claim("email"),
  ]);
  assertEquals(phone.length, 1);
  assertEquals(email.length, 1);
  assertEquals(phone[0].channel, "ntfy");
  assertEquals(email[0].channel, "email");
  assertEquals(
    await store.finish(
      { ...phone[0], lease_token: crypto.randomUUID() },
      "sent",
      "wrong",
      null,
      null,
    ),
    false,
  );
  assertEquals(
    await deliverRow(
      store,
      phone[0],
      () => Promise.resolve({ providerId: "phone-ok" }),
    ),
    "sent",
  );
  assertEquals(
    await deliverRow(
      store,
      email[0],
      () => Promise.reject(new Error("SMTP unavailable")),
    ),
    "retry_wait",
  );
  const snapshot = await store.list();
  assertEquals(
    snapshot.rules[0].deliveries.find((r: LocalDelivery) =>
      r.channel === "ntfy"
    ).state,
    "sent",
  );
  const rearmed = await store.change(rule.id, "enable", "test");
  const id = await store.record({
    ...candidate,
    revision: rearmed.updated_at,
    observedAt: new Date(Date.now() + 30).toISOString(),
  });
  assert(id);
  assertEquals(
    (await store.sql`select count(*)::int as count from alert_occurrences`)[0]
      .count,
    2,
  );
  await store.setActive(false);
  await store.close();
});
