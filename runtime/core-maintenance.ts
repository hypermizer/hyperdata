import { createServiceClient } from "../supabase/functions/_shared/database.ts";
const client = createServiceClient(
  Deno.env.get("LOCAL_DATA_URL")!,
  Deno.env.get("LOCAL_SERVICE_TOKEN")!,
);
for (const name of ["prune_paper_diagnostics", "prune_listener_history"]) {
  const result = await client.rpc(name);
  if (result.error) throw new Error(name + ": " + result.error.message);
  console.log(JSON.stringify({ job: name, result: result.data }));
}
