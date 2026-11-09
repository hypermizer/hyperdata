import type { AlertStore } from "./store.ts";
import {
  liquidationAsset,
  type LiquidationSnapshot,
} from "./liquidation-data.ts";
export class LiquidationStore {
  constructor(readonly sql: AlertStore["sql"]) {}
  async watch(asset: string, history = false) {
    liquidationAsset(asset);
    return await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(61778291)`;
      const rows =
        await tx`insert into liquidation_requests(asset,watch_until,history_requested)
      select ${asset},now()+interval '2 minutes',${history}
      where (select count(*) from liquidation_requests where watch_until>now())<8
      or exists(select 1 from liquidation_requests where asset=${asset} and watch_until>now())
      on conflict(asset) do update set requested_at=now(),watch_until=now()+interval '2 minutes',
      history_requested=liquidation_requests.history_requested or excluded.history_requested,
      history_complete=case when excluded.history_requested and liquidation_requests.history_end<now()-interval '6 hours' then false else liquidation_requests.history_complete end,
      history_cursor=case when excluded.history_requested and liquidation_requests.history_end<now()-interval '6 hours' then null else liquidation_requests.history_cursor end,
      history_start=case when excluded.history_requested and liquidation_requests.history_end<now()-interval '6 hours' then null else liquidation_requests.history_start end,
      history_end=case when excluded.history_requested and liquidation_requests.history_end<now()-interval '6 hours' then null else liquidation_requests.history_end end
      returning asset`;
      return rows.length > 0;
    });
  }
  async read(asset: string, includeHistory = false) {
    liquidationAsset(asset);
    const [request] = await this
      .sql`select asset,status,last_error,history_requested,history_complete from liquidation_requests where asset=${asset}`;
    const latest = await this
      .sql`select payload from liquidation_snapshots where asset=${asset} order by snapshot_at desc limit 2`;
    const history = includeHistory
      ? await this
        .sql`select payload from liquidation_snapshots where asset=${asset} and snapshot_at>=now()-interval '24 hours' order by snapshot_at limit 400`
      : [];
    const [provider] = await this
      .sql`select status,cooldown_until,credits_remaining,collector_heartbeat from liquidation_provider_state where id`;
    return {
      asset,
      latest: latest[0]?.payload ?? null,
      previous: latest[1]?.payload ?? null,
      history: history.map((r) => r.payload),
      request: request ??
        {
          status: "pending",
          history_requested: false,
          history_complete: false,
        },
      provider,
      range_pct: 10,
      buckets: 100,
    };
  }
  async save(asset: string, snapshots: LiquidationSnapshot[]) {
    await this.sql.begin(async (tx) => {
      for (const snapshot of snapshots) {
        await tx`insert into liquidation_snapshots(asset,snapshot_at,payload) values(${asset},${snapshot.snapshot_ts},${
          tx.json(snapshot)
        })
        on conflict(asset,snapshot_at) do update set payload=case when excluded.payload->>'source'='unknown'
        and liquidation_snapshots.payload->>'source'!='unknown' then liquidation_snapshots.payload else excluded.payload end`;
      }
    });
  }
}
