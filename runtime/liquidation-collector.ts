import { AlertStore } from "./store.ts";
import { LiquidationStore } from "./liquidation-store.ts";
import {
  fetchLiquidations,
  LiquidationProviderError,
} from "./liquidation-data.ts";

// One collector, serial requests, durable demand/cursors, and hard request budgets.
// Provider credits are shared with any other applications using this account.
export async function collectLiquidations(
  db: AlertStore,
  key: string,
  fetcher = fetchLiquidations,
) {
  const lock = await db.sql.reserve();
  let locked = false;
  try {
    [{ locked }] = await lock`select pg_try_advisory_lock(61778292) as locked`;
    if (locked) await collectCycle(db, key, fetcher);
  } finally {
    if (locked) await lock`select pg_advisory_unlock(61778292)`;
    lock.release();
  }
}
async function collectCycle(
  db: AlertStore,
  key: string,
  fetcher: typeof fetchLiquidations,
) {
  const sql = db.sql, store = new LiquidationStore(sql);
  await sql`update liquidation_provider_state set collector_heartbeat=now() where id`;
  const [provider] =
    await sql`select * from liquidation_provider_state where id`;
  if (
    provider?.cooldown_until && Date.parse(provider.cooldown_until) > Date.now()
  ) return;
  const [usage] =
    await sql`select count(*) filter(where fetched_at>=date_trunc('day',now()))::int as daily,
    count(*) filter(where fetched_at>=date_trunc('month',now()))::int as monthly from liquidation_fetch_log`;
  if (usage.daily >= 200 || usage.monthly >= 1000) {
    await sql`update liquidation_provider_state set status='request_budget',cooldown_until=${
      usage.monthly >= 1000
        ? new Date(
          Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth() + 1,
            1,
          ),
        )
        : new Date(
          Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth(),
            new Date().getUTCDate() + 1,
          ),
        )
    },updated_at=now() where id`;
    return;
  }
  const rows =
    await sql`select * from liquidation_requests where watch_until>now()
    and (next_fetch_at<=now() or (history_requested and not history_complete and history_next_at<=now()))
    order by next_fetch_at,requested_at desc limit 4`;
  let calls = 0;
  for (const row of rows) {
    if (
      calls >= 4 || usage.daily + calls >= 200 || usage.monthly + calls >= 1000
    ) break;
    const history = Date.parse(row.next_fetch_at) > Date.now();
    if (history && (!row.history_requested || row.history_complete)) continue;
    const query: Record<string, string> = {};
    if (history) {
      const end = row.history_end ? new Date(row.history_end) : new Date();
      const start = row.history_start
        ? new Date(row.history_start)
        : new Date(end.getTime() - 86400_000);
      query.start = start.toISOString();
      query.end = end.toISOString();
      query.limit = "100";
      if (row.history_cursor) query.cursor = row.history_cursor;
      await sql`update liquidation_requests set history_start=${start},history_end=${end},history_next_at=now()+interval '1 minute' where asset=${row.asset}`;
    } else {
      await sql`update liquidation_requests set next_fetch_at=now()+interval '5 minutes',status='fetching' where asset=${row.asset}`;
    }
    const [attempt] =
      await sql`insert into liquidation_fetch_log(asset,kind) values(${row.asset},${
        history ? "history" : "latest"
      }) returning id`;
    calls++;
    try {
      const result = await fetcher(row.asset, key, query);
      // Cursor must advance, and all history points must belong to the requested interval.
      if (
        history &&
        (result.next && result.next === row.history_cursor ||
          result.snapshots.some((s) =>
            s.snapshot_ts_ms < Date.parse(query.start) ||
            s.snapshot_ts_ms > Date.parse(query.end)
          ))
      ) throw new Error("History pagination did not advance within its window");
      await store.save(row.asset, result.snapshots);
      await sql`update liquidation_fetch_log set status=200 where id=${attempt.id}`;
      await sql`update liquidation_provider_state set status='ready',cooldown_until=null,
        credits_remaining=${result.creditsRemaining},credits_reset=${result.creditsReset},updated_at=now() where id`;
      if (history) {
        await sql`update liquidation_requests set history_cursor=${result.next},history_complete=${
          result.next === null
        },history_next_at=now(),
          last_error=null,status='ready' where asset=${row.asset}`;
      } else {
        await sql`update liquidation_requests set status='ready',last_error=null where asset=${row.asset}`;
      }
      if (result.creditsRemaining !== null && result.creditsRemaining < 5000) {
        await sql`update liquidation_provider_state set status='credit_reserve',cooldown_until=${
          result.creditsReset
            ? new Date(result.creditsReset * 1000)
            : new Date(Date.now() + 86400_000)
        },updated_at=now() where id`;
        break;
      }
    } catch (error) {
      const e = error instanceof LiquidationProviderError ? error : null;
      await sql`update liquidation_fetch_log set status=${
        e?.status ?? 0
      } where id=${attempt.id}`;
      const quota = e?.code === "insufficient_credits",
        authentication = e?.status === 401 || e?.status === 403;
      const unavailable = e?.status === 404 || e?.status === 400 ||
        e?.status === 422;
      const message = quota
        ? "0xArchive credits exhausted; collection paused."
        : authentication
        ? "0xArchive account access needs attention."
        : unavailable
        ? "No supported liquidation snapshot is available for this market."
        : "0xArchive is temporarily unavailable; the last snapshot is retained.";
      const delay = quota
        ? Math.max(
          86400,
          Number(provider?.credits_reset ?? 0) - Date.now() / 1000,
        )
        : authentication || unavailable
        ? 3600
        : e?.retrySeconds ?? 180;
      await sql`update liquidation_requests set status=${
        unavailable ? "unavailable" : "retry_wait"
      },last_error=${message},
        next_fetch_at=now()+${delay}*interval '1 second',history_next_at=now()+${delay}*interval '1 second' where asset=${row.asset}`;
      if (quota || authentication || e?.status === 429 || e?.status === 503) {
        await sql`update liquidation_provider_state set status=${
          quota
            ? "credits_exhausted"
            : authentication
            ? "account_unavailable"
            : "provider_backoff"
        },
          cooldown_until=now()+${delay}*interval '1 second',updated_at=now() where id`;
        break;
      }
    }
  }
}

if (import.meta.main) {
  const key = Deno.env.get("OXARCHIVE_API_KEY");
  if (!key) throw new Error("0xArchive key is required");
  const db = new AlertStore({ max: 2 });
  const abort = new AbortController();
  let prunedAt = 0;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => abort.abort());
  }
  try {
    while (!abort.signal.aborted) {
      try {
        await collectLiquidations(db, key);
        if (Date.now() - prunedAt > 3600_000) {
          await db
            .sql`delete from liquidation_snapshots where snapshot_at<now()-interval '30 days'`;
          await db
            .sql`delete from liquidation_fetch_log where fetched_at<now()-interval '35 days'`;
          prunedAt = Date.now();
        }
      } catch {
        console.error(
          "Liquidation collector cycle deferred; alert workers are independent.",
        );
      }
      if (abort.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 3000);
        abort.signal.addEventListener("abort", finish, { once: true });
      });
    }
  } finally {
    await db.close();
  }
}
