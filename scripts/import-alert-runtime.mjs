// One-time, read-only Supabase export. This script never changes the source engine.
import { readFile, writeFile } from "node:fs/promises";
const token = (process.env.SUPABASE_ACCESS_TOKEN ??
  await readFile(
    "/home/ubuntu/.config/hypergarden/supabase-access-token",
    "utf8",
  )).trim();
const project = "itheknkmuutquriojdzt";
async function query(query) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${project}/database/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, read_only: true }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) {
    throw new Error(`Source export failed (${response.status})`);
  }
  return await response.json();
}
const tables = [
  "alert_rules",
  "alert_occurrences",
  "notification_outbox",
  "rule_evaluation_state",
  "detector_models",
  "volatility_states",
];
const result = { exportedAt: new Date().toISOString(), tables: {} };
for (const table of tables) {
  result.tables[table] = await query(
    `select to_jsonb(t) as row from public.${table} t`,
  );
}
const path = process.env.ALERT_EXPORT_PATH ??
  "/home/ubuntu/.config/hyperdata/alert-export.json";
await writeFile(path, JSON.stringify(result), { mode: 0o600 });
console.log(
  "Exported alert data without changing source:",
  Object.fromEntries(
    tables.map((table) => [table, result.tables[table].length]),
  ),
);
