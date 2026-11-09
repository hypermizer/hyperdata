import type { Candidate } from "./engine.ts";

export async function readSpool(path: string): Promise<Candidate[]> {
  try {
    const value = JSON.parse(await Deno.readTextFile(path));
    if (!Array.isArray(value) || value.some((row) => typeof row.key !== "string" || typeof row.ruleId !== "string"
      || typeof row.revision !== "string" || !Number.isFinite(Date.parse(row.observedAt)) || !Number.isFinite(row.mark) || row.mark <= 0)) {
      throw new Error("Invalid price-alert spool; refusing to discard pending occurrences");
    }
    return value;
  } catch (error) { if (error instanceof Deno.errors.NotFound) return []; throw error; }
}

export async function saveSpool(path: string, rows: Candidate[]) {
  const temporary = `${path}.tmp`;
  const file = await Deno.open(temporary, { create: true, write: true, truncate: true, mode: 0o600 });
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    let offset = 0;
    while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
    await file.sync();
  } finally { file.close(); }
  await Deno.rename(temporary, path);
  const directory = await Deno.open(path.slice(0, path.lastIndexOf("/")) || ".", { read: true });
  try { await directory.sync(); } finally { directory.close(); }
}
