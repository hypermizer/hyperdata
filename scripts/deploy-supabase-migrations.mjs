import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_ID;
if (!token || !projectRef) throw new Error("SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_ID are required");

const endpoint = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`;
async function query(sql, parameters = []) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: sql, parameters, read_only: false }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase migration API returned ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : [];
}

await query(`
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (
    version text primary key,
    statements text[],
    name text
  )
`);
const appliedResult = await query("select version from supabase_migrations.schema_migrations order by version");
const rows = Array.isArray(appliedResult) ? appliedResult : appliedResult.result ?? [];
const applied = new Set(rows.map((row) => String(row.version)));
const directory = path.resolve("supabase/migrations");
const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();

for (const file of files) {
  const [version, ...nameParts] = file.replace(/\.sql$/, "").split("_");
  if (applied.has(version)) continue;
  const sql = await readFile(path.join(directory, file), "utf8");
  const name = nameParts.join("_");
  if (!/^\d+$/.test(version) || !/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe migration filename: ${file}`);
  await query(`begin;\n${sql}\ninsert into supabase_migrations.schema_migrations(version, statements, name) values ('${version}', null, '${name}');\ncommit;`);
  console.log(`Applied ${file}`);
}

const verification = await query("select version, name from supabase_migrations.schema_migrations order by version");
const verifiedRows = Array.isArray(verification) ? verification : verification.result ?? [];
for (const file of files) {
  const version = file.split("_", 1)[0];
  if (!verifiedRows.some((row) => String(row.version) === version)) throw new Error(`Migration ${version} was not recorded`);
}
console.log(`Verified ${files.length} local migrations on ${projectRef}`);
