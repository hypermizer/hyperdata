import { AlertStore } from "./store.ts";
const store = new AlertStore();
try {
  const action = Deno.args[0];
  if (action === "activate" || action === "pause") {
    await store.setActive(action === "activate");
    console.log(
      `Local alert engine ${action === "activate" ? "active" : "paused"}`,
    );
  } else if (action === "status") {
    console.log(JSON.stringify(
      {
        health: await store.health(),
        queue: await store
          .sql`select channel,state,count(*)::int as count from notification_outbox group by channel,state`,
        rules: await store
          .sql`select count(*)::int as count from alert_rules where enabled and deleted_at is null`,
      },
      null,
      2,
    ));
  } else if (action === "revoke-client") {
    const fingerprint = Deno.args[1]?.replaceAll(":", "").toUpperCase();
    if (!fingerprint || !/^[A-F0-9]{40}$/.test(fingerprint)) {
      throw new Error("Valid certificate fingerprint required");
    }
    await store
      .sql`insert into revoked_clients(fingerprint) values(${fingerprint}) on conflict do nothing`;
    console.log("Client certificate revoked for the alert API.");
  } else {throw new Error(
      "Use activate, pause, status, or revoke-client FINGERPRINT",
    );}
} finally {
  await store.close();
}
