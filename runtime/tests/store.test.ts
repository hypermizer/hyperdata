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
Deno.test("local transactions create only ntfy jobs and preserve fenced, retryable delivery", async () => {
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
  assertEquals(email.length, 0);
  assertEquals(phone[0].channel, "ntfy");
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
    (await store
      .sql`select count(*)::int as count from notification_outbox where channel='email'`)[
        0
      ].count,
    0,
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
  await store
    .sql`insert into notification_outbox(occurrence_id,user_id,channel) values(${id},${owner},'email')`;
  await store.sql.unsafe(
    await Deno.readTextFile(
      new URL("../migrations/003_ntfy_only.sql", import.meta.url),
    ),
  );
  assertEquals(
    (await store
      .sql`select state from notification_outbox where channel='email'`)[0]
      .state,
    "failed",
  );
  assertEquals(await store.claim("email"), []);
  assertEquals(
    (await store.sql`select distinct delivery from alert_rules`)[0].delivery,
    "ntfy",
  );
  await store.setActive(false);
  await store.close();
});
