const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_ID;
const monitorSecret = process.env.MONITOR_SECRET;
if (!token || !projectRef || !monitorSecret) throw new Error("SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_ID, and MONITOR_SECRET are required");

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const keysResponse = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/api-keys`, { headers });
if (!keysResponse.ok) throw new Error(`Unable to retrieve project API keys (${keysResponse.status})`);
const keys = await keysResponse.json();
const serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key;
if (!serviceRoleKey) throw new Error("Project service-role key was unavailable");

const queryUrl = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`;
async function query(sql, parameters = []) {
  const response = await fetch(queryUrl, { method: "POST", headers, body: JSON.stringify({ query: sql, parameters, read_only: false }) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Runtime configuration query failed (${response.status}): ${body.slice(0, 300)}`);
}

const secrets = [
  ["project_url", `https://${projectRef}.supabase.co`],
  ["service_role_key", serviceRoleKey],
  ["monitor_secret", monitorSecret],
];
for (const [name, value] of secrets) {
  await query("delete from vault.secrets where name = $1", [name]);
  await query("select vault.create_secret($1, $2)", [value, name]);
}
await query("select public.configure_listener_cron()");
console.log("Configured Hyperdata Vault secrets and listener cron jobs");
