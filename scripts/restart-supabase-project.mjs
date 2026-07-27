import { pathToFileURL } from "node:url";

export async function restartSupabaseProject({
  env = process.env,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = console,
  maxAttempts = 24,
} = {}) {
  const token = required(env, "SUPABASE_ACCESS_TOKEN");
  const projectRef = required(env, "SUPABASE_PROJECT_ID");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const baseUrl = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}`;

  const restart = await fetchImpl(`${baseUrl}/restart`, { method: "POST", headers });
  if (!restart.ok) throw new Error(`Supabase restart request failed (${restart.status})`);
  logger.log("Supabase restart accepted; waiting for Postgres");

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const health = await fetchImpl(`${baseUrl}/database/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "select 1 as ready", read_only: true }),
    });
    if (health.ok) {
      logger.log("Supabase Postgres recovered after restart");
      return;
    }
    if (attempt + 1 < maxAttempts) await sleep(5_000);
  }
  throw new Error("Supabase database did not recover after restart");
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await restartSupabaseProject();
}
