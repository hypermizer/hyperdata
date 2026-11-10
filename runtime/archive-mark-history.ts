import { createServiceClient } from "../supabase/functions/_shared/database.ts";
import { archiveMarkUrl, parseArchiveMarks } from "./archive-mark-data.ts";
const client = createServiceClient(
  Deno.env.get("LOCAL_DATA_URL")!,
  Deno.env.get("LOCAL_SERVICE_TOKEN")!,
);
const key = Deno.env.get("OXARCHIVE_API_KEY");
if (!key) throw Error("Archive key unavailable");
let stopping = false, nextRequest = 0;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => {
    stopping = true;
  });
}
async function rpc(name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw Error(error.message);
  return data;
}
async function worker() {
  while (!stopping) {
    try {
      const job = await rpc("claim_mark_archive_job");
      if (!job) {
        await wait(1000);
        continue;
      }
      const start = Math.max(Date.now(), nextRequest);
      nextRequest = start + 125;
      if (start > Date.now()) await wait(start - Date.now());
      let points: ReturnType<typeof parseArchiveMarks>["points"] = [],
        cursor: string | null = null,
        error: string | null = null,
        retry = 0,
        credits: number | null = null;
      try {
        if (!await rpc("reserve_mark_archive_request")) {
          retry = 3600;
          throw Error("Archive request budget/reserve reached");
        }
        const response = await fetch(
          archiveMarkUrl(
            job.asset,
            Number(job.start_ms),
            Number(job.end_ms),
            job.cursor,
          ),
          {
            headers: { "X-API-Key": key!, "0xArchive-Version": "2026-10-01" },
            signal: AbortSignal.timeout(20000),
            redirect: "error",
          },
        );
        const balance = response.headers.get("x-credits-remaining");
        credits = balance === null ? null : Number(balance);
        if (!response.ok) {
          retry = response.status === 429
            ? Math.max(10, Number(response.headers.get("retry-after")) || 30)
            : response.status === 403
            ? 3600
            : 60;
          throw Error("Archive price request " + response.status);
        }
        const parsed = parseArchiveMarks(
          await response.json(),
          job.asset,
          Number(job.start_ms),
          Number(job.end_ms),
        );
        points = parsed.points;
        cursor = parsed.cursor;
        if (!points.length && cursor === null) retry = 3600;
      } catch (e) {
        error = e instanceof Error
          ? e.message
          : "Archive mark retrieval failed";
        retry ||= 60;
      }
      const accepted = await rpc("finish_mark_archive_page", {
        p_asset: job.asset,
        p_band: job.band,
        p_lease: job.lease_token,
        p_points: points,
        p_cursor: cursor,
        p_error: error,
        p_retry_seconds: retry,
        p_credits: credits,
      });
      console.log(
        JSON.stringify({
          asset: job.asset,
          band: job.band,
          points: points.length,
          more: Boolean(cursor),
          error,
          accepted,
        }),
      );
    } catch (e) {
      console.error(e instanceof Error ? e.message : "Archive worker failure");
      await wait(3000);
    }
  }
}
await Promise.all([worker(), worker()]);
