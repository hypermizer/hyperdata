import { serveProcessPaper } from "../supabase/functions/process-paper/index.ts";
import { serveAccountSync } from "../supabase/functions/sync-hyperliquid-account/index.ts";

// Sequential calls plus the original SQL lease fencing prevent overlap, including
// after restarts. Every retry keeps the original cursor/idempotency semantics.
const job = Deno.args[0];
if (!["paper", "account-sync"].includes(job)) {
  throw new Error("Unknown core job");
}
const interval = job === "paper" ? 10_000 : 60_000;
const handler = job === "paper" ? serveProcessPaper : serveAccountSync;
const secret = Deno.env.get(
  job === "paper" ? "PAPER_SCHEDULER_SECRET" : "MONITOR_SECRET",
);
if (!secret) throw new Error("Missing scheduler identity");
let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => {
    stopping = true;
    wake?.();
  });
}
while (!stopping) {
  const start = Date.now();
  try {
    const response = await handler(
      new Request("http://local-worker/" + job, {
        method: "POST",
        headers: { "x-monitor-secret": secret },
      }),
    );
    const result = await response.json();
    if (!response.ok) {
      console.error(JSON.stringify({ job, status: response.status, result }));
    } else {console.log(
        JSON.stringify({ job, status: response.status, result }),
      );}
  } catch (error) {
    console.error(
      JSON.stringify({
        job,
        error: error instanceof Error ? error.message : "Worker error",
      }),
    );
  }
  if (!stopping) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, Math.max(1000, interval - (Date.now() - start)));
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  }
}
