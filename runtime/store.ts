import postgres from "postgres";
import type {
  AlertRule,
  DetectorModel,
  MarketObservation,
  VolatilityState,
} from "../supabase/functions/_shared/types.ts";
import type { Candidate, StreamRule } from "../scripts/price-stream/engine.ts";

export interface LocalDelivery {
  id: string;
  occurrence_id: string;
  channel: "email" | "ntfy";
  attempts: number;
  lease_token: string;
  occurrence: {
    asset: string;
    detector: string;
    mark_price: number;
    classification: string;
    evidence: Record<string, unknown>;
    bucket: string;
  };
}
export class AlertStore {
  readonly sql: ReturnType<typeof postgres>;
  constructor(options: Record<string, unknown> = {}) {
    this.sql = postgres({
      host: Deno.env.get("PGHOST") ?? "/run/postgresql-hyperdata",
      port: Number(Deno.env.get("PGPORT") ?? 5545),
      user: Deno.env.get("PGUSER") ?? "hyperdata",
      database: Deno.env.get("PGDATABASE") ?? "hyperdata",
      max: 5,
      idle_timeout: 20,
      connect_timeout: 5,
      ...options,
    });
  }
  async migrate(
    path = new URL("./migrations/001_alerts.sql", import.meta.url),
  ) {
    await this.sql.unsafe(await Deno.readTextFile(path));
  }
  async active() {
    const [r] = await this
      .sql`select value from runtime_settings where key='active'`;
    return r?.value === true;
  }
  async setActive(active: boolean) {
    await this.sql`update runtime_settings set value=${
      this.sql.json(active)
    } where key='active'`;
    await this.sql`select pg_notify('hyperdata_rules','settings')`;
  }
  async activeRules(): Promise<StreamRule[]> {
    const rows = await this
      .sql`select to_jsonb(r) as rule from alert_rules r where enabled and deleted_at is null order by created_at`;
    return rows.map((r) => r.rule as StreamRule);
  }
  async list() {
    const rules = await this.sql`select to_jsonb(r) as rule,
   (select to_jsonb(o) from alert_occurrences o where o.rule_id=r.id order by o.created_at desc limit 1) as occurrence,
   (select coalesce(jsonb_agg(to_jsonb(d) - 'lease_token'),'[]') from notification_outbox d
      where d.occurrence_id=(select o.id from alert_occurrences o where o.rule_id=r.id order by o.created_at desc limit 1)) as deliveries,
   (select to_jsonb(s) from rule_evaluation_state s where s.rule_id=r.id) as evaluation
   from alert_rules r where r.deleted_at is null order by r.created_at desc limit 500`;
    const health = await this
      .sql`select worker_id,heartbeat_at::text,details from runtime_health`;
    return {
      rules: rules.map((r) => ({
        ...r.rule,
        occurrence: r.occurrence,
        deliveries: r.deliveries ?? [],
        evaluation: r.evaluation,
      })),
      health,
      backend: "server",
    };
  }
  async create(
    input: {
      asset: string;
      dex: string;
      detector: string;
      configuration: Record<string, unknown>;
    },
    owner: string,
    fingerprint: string,
  ) {
    return await this.sql.begin(async (tx) => {
      const [row] =
        await tx`insert into alert_rules(user_id,asset,dex,detector,configuration) values(${owner},${input.asset},${input.dex},${input.detector},${
          tx.json(input.configuration)
        }) returning to_jsonb(alert_rules) as rule`;
      await tx`insert into audit_events(action,rule_id,client_fingerprint) values('created',${row.rule.id},${fingerprint})`;
      return row.rule;
    });
  }
  async change(
    id: string,
    action: "enable" | "disable" | "delete",
    fingerprint: string,
  ) {
    return await this.sql.begin(async (tx) => {
      const [row] = await tx`update alert_rules set enabled=${
        action === "enable"
      },deleted_at=case when ${action}='delete' then clock_timestamp() else deleted_at end,
     updated_at=clock_timestamp() where id=${id} and deleted_at is null returning to_jsonb(alert_rules) as rule`;
      if (!row) throw new Error("Rule not found");
      await tx`delete from rule_evaluation_state where rule_id=${id}`;
      await tx`insert into audit_events(action,rule_id,client_fingerprint) values(${action},${id},${fingerprint})`;
      return row.rule;
    });
  }
  async record(
    candidate: Candidate,
    source = "websocket",
    result?: { classification: string; evidence: Record<string, unknown> },
  ) {
    return await this.sql.begin(async (tx) => {
      const [control] =
        await tx`select value from runtime_settings where key='active' for share`;
      if (control?.value !== true) {
        throw new Error("Local alert engine is paused");
      }
      const [row] =
        await tx`select to_jsonb(r) as rule from alert_rules r where id=${candidate.ruleId} and enabled and deleted_at is null for update`;
      if (!row) return null;
      const rule = row.rule as StreamRule;
      const [valid] =
        await tx`select ${candidate.revision}::timestamptz=${rule.updated_at}::timestamptz as revision,
      ${candidate.observedAt}::timestamptz>=${rule.updated_at}::timestamptz and ${candidate.observedAt}::timestamptz<=clock_timestamp()+interval '5 seconds' as observed`;
      if (
        rule.asset !== candidate.asset || !valid.revision || !valid.observed ||
        !Number.isFinite(candidate.mark) || candidate.mark <= 0
      ) return null;
      if (rule.detector === "fixed_price") {
        const target = Number(rule.configuration.target),
          direction = rule.configuration.direction;
        if (
          !Number.isFinite(target) || target <= 0 ||
          !(direction === "above"
            ? candidate.mark >= target
            : direction === "below"
            ? candidate.mark <= target
            : false)
        ) return null;
      } else if (!result) return null;
      const dedupe = rule.detector === "fixed_price"
        ? `fixed:${rule.updated_at}`
        : `move:${Math.floor(Date.parse(candidate.observedAt) / 60_000)}`;
      const evidence = {
        ...result?.evidence,
        source,
        observedAt: candidate.observedAt,
        ruleUpdatedAt: candidate.revision,
        ...(rule.detector === "fixed_price"
          ? {
            target: rule.configuration.target,
            direction: rule.configuration.direction,
            markPrice: candidate.mark,
          }
          : {}),
      };
      const [created] =
        await tx`insert into alert_occurrences(rule_id,user_id,bucket,asset,detector,mark_price,classification,evidence,dedupe_key)
    values(${rule.id},${rule.user_id},${candidate.observedAt},${rule.asset},${rule.detector},${candidate.mark},${
          result?.classification ?? "fixed_price"
        },${tx.json(evidence)},${dedupe})
    on conflict(rule_id,dedupe_key) do nothing returning id`;
      if (!created) return null;
      await tx`insert into notification_outbox(occurrence_id,user_id,channel) values(${created.id},${rule.user_id},'email'),(${created.id},${rule.user_id},'ntfy')`;
      if (rule.detector === "fixed_price") {
        await tx`update alert_rules set enabled=false,updated_at=clock_timestamp() where id=${rule.id}`;
      }
      await tx`insert into rule_evaluation_state(rule_id,bucket,status,details) values(${rule.id},${candidate.observedAt},'triggered',${
        tx.json(evidence)
      })
    on conflict(rule_id) do update set bucket=excluded.bucket,status='triggered',details=excluded.details,updated_at=clock_timestamp()`;
      return String(created.id);
    });
  }
  async claim(channel: "email" | "ntfy", limit = 10): Promise<LocalDelivery[]> {
    const rows = await this.sql`with due as (
   select id from notification_outbox where channel=${channel} and ((state in ('queued','retry_wait') and next_attempt_at<=now()) or (state='claimed' and lease_until<now()))
   and (select value='true'::jsonb from runtime_settings where key='delivery_enabled')
   and (select value='true'::jsonb from runtime_settings where key='active')
   order by next_attempt_at,created_at for update skip locked limit ${limit}
  ), claimed as (
   update notification_outbox d set state='claimed',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=clock_timestamp()
   from due where d.id=due.id returning d.*
  ) select to_jsonb(c) || jsonb_build_object('occurrence',to_jsonb(o)) as delivery from claimed c join alert_occurrences o on o.id=c.occurrence_id`;
    return rows.map((r) => r.delivery as LocalDelivery);
  }
  async finish(
    row: LocalDelivery,
    state: string,
    providerId: string | null,
    error: string | null,
    next: string | null,
  ) {
    const rows = await this
      .sql`update notification_outbox set state=${state},provider_id=${providerId},last_error=${
      error?.slice(0, 500) ?? null
    },
   next_attempt_at=coalesce(${next}::timestamptz,next_attempt_at),lease_until=null,lease_token=null,updated_at=clock_timestamp()
   where id=${row.id} and lease_token=${row.lease_token} and attempts=${row.attempts} and state='claimed' and lease_until>now() returning id`;
    return rows.length === 1;
  }
  async heartbeat(id: string, details: Record<string, unknown>) {
    await this.sql`insert into runtime_health(worker_id,details) values(${id},${
      this.sql.json(details)
    }) on conflict(worker_id) do update set heartbeat_at=clock_timestamp(),details=excluded.details`;
  }
  async revoked(fingerprint: string) {
    return (await this
      .sql`select 1 from revoked_clients where fingerprint=${fingerprint}`)
      .length > 0;
  }
  async health() {
    const rows = await this
      .sql`select worker_id,extract(epoch from now()-heartbeat_at) as age,details from runtime_health`;
    const stream = rows.find((r) => r.worker_id === "stream"),
      fallback = rows.find((r) => r.worker_id === "fallback");
    const streamFresh = Boolean(
      stream && Number(stream.age) < 20 && stream.details.connected &&
        stream.details.stale_assets?.length === 0 &&
        Date.now() - Date.parse(stream.details.last_market_at) < 15_000 &&
        Date.now() - Date.parse(stream.details.rules_refreshed_at) < 20_000,
    );
    const fallbackFresh = Boolean(
      fallback && Number(fallback.age) < 45 &&
        fallback.details.state === "succeeded",
    );
    const [pending] = await this
      .sql`select count(*)::int as count from notification_outbox where
   (state not in ('sent','failed','ambiguous') and created_at<now()-interval '2 minutes')
   or (state in ('failed','ambiguous') and updated_at>now()-interval '24 hours')`;
    const active = await this.active();
    return {
      healthy: active && streamFresh && fallbackFresh && pending.count === 0,
      maintenance: !active,
      streamFresh,
      fallbackFresh,
      deliveryBacklog: pending.count,
      backend: "local",
    };
  }
  async saveObservation(row: MarketObservation) {
    await this
      .sql`insert into market_observations(asset,bucket,observation) values(${row.asset},${row.bucket},${
      this.sql.json(row)
    }) on conflict do nothing`;
  }
  async moveContext(rule: AlertRule, bucket: Date) {
    const horizon = Number(rule.configuration.horizon_minutes),
      target = new Date(bucket.getTime() - horizon * 60_000);
    const [refs, models, states] = await Promise.all([
      this
        .sql`select observation from market_observations where asset=${rule.asset} and bucket between ${new Date(
        target.getTime() - 75_000,
      )} and ${new Date(
        target.getTime() + 75_000,
      )} order by abs(extract(epoch from bucket-${target}::timestamptz)) limit 1`,
      this
        .sql`select model from detector_models where asset=${rule.asset} and horizon_minutes=${horizon} and expires_at>now()`,
      this.sql`select state from volatility_states where asset=${rule.asset}`,
    ]);
    return {
      reference: refs[0]?.observation as MarketObservation | undefined,
      model: models[0]?.model as DetectorModel | undefined,
      volatilityState: states[0]?.state as VolatilityState | undefined,
    };
  }
  async evaluation(
    rule: StreamRule,
    bucket: string,
    status: string,
    details: Record<string, unknown>,
  ) {
    await this
      .sql`insert into rule_evaluation_state(rule_id,bucket,status,details)
    select id,${bucket},${status},${
      this.sql.json(details)
    } from alert_rules where id=${rule.id} and enabled and updated_at=${rule.updated_at}::timestamptz
    on conflict(rule_id) do update set bucket=excluded.bucket,status=excluded.status,details=excluded.details,updated_at=clock_timestamp()
     where rule_evaluation_state.bucket<=excluded.bucket`;
  }
  async saveModel(model: DetectorModel) {
    await this
      .sql`insert into detector_models(asset,horizon_minutes,model,expires_at) values(${model.asset},${model.horizon_minutes},${
      this.sql.json(model)
    },${model.expires_at}) on conflict(asset,horizon_minutes) do update set model=excluded.model,expires_at=excluded.expires_at`;
  }
  async saveVolatility(state: VolatilityState) {
    await this
      .sql`insert into volatility_states(asset,state) values(${state.asset},${
      this.sql.json(state)
    }) on conflict(asset) do update set state=excluded.state`;
  }
  async prune() {
    await this
      .sql`delete from market_observations where bucket<now()-interval '30 days'`;
  }
  async close() {
    await this.sql.end({ timeout: 5 });
  }
}
