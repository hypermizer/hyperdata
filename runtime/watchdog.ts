import { coreHealth } from "./core-health.ts";
import { AlertStore } from "./store.ts";
// Local observation is deliberately silent. The independent controller is the
// sole owner of runtime-health notifications; asset-price delivery is separate.
const store = new AlertStore();
try {
  const [alerts, core] = await Promise.all([
    store.health(),
    Deno.env.get("LOCAL_CORE_ENABLED") === "true"
      ? coreHealth()
      : Promise.resolve(null),
  ]);
  const snapshot = {
    checkedAt: new Date().toISOString(),
    healthy: alerts.healthy && (core?.healthy ?? true),
    maintenance: alerts.maintenance,
    priceAlerts: alerts,
    core,
  };
  const path = "/srv/hyperdata/state/watchdog.json";
  await Deno.writeTextFile(path + ".tmp", JSON.stringify(snapshot), {
    mode: 0o600,
  });
  await Deno.rename(path + ".tmp", path);
  console.log(JSON.stringify(snapshot));
} catch (e) {
  console.error(
    "Local health observation failed:",
    e instanceof Error ? e.name : "Error",
  );
  Deno.exitCode = 1;
} finally {
  await store.close();
}
