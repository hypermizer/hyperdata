import { AlertStore } from "./store.ts";
const path = Deno.args[0];
if (!path) throw new Error("Export path required");
const data = JSON.parse(await Deno.readTextFile(path)),
  store = new AlertStore();
try {
  if (await store.active()) {
    throw new Error("Refusing an import while the local engine is active");
  }
  await store.sql.begin(async (tx) => {
    for (const item of data.tables.alert_rules) {
      const r = item.row;
      await tx`insert into alert_rules(id,user_id,asset,dex,detector,detector_version,configuration,delivery,enabled,deleted_at,created_at,updated_at)
    values(${r.id},${r.user_id},${r.asset},${r.dex},${r.detector},${r.detector_version},${
        tx.json(r.configuration)
      },'ntfy',${r.enabled},${r.deleted_at},${r.created_at},${r.updated_at})
    on conflict(id) do update set enabled=excluded.enabled,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at,configuration=excluded.configuration`;
    }
    for (const item of data.tables.alert_occurrences) {
      const o = item.row;
      await tx`insert into alert_occurrences(id,rule_id,user_id,bucket,asset,detector,mark_price,classification,evidence,dedupe_key,created_at)
    values(${o.id},${o.rule_id},${o.user_id},${o.bucket},${o.asset},${o.detector},${o.mark_price},${o.classification},${
        tx.json(o.evidence)
      },${"import:" + o.id},${o.created_at}) on conflict(id) do nothing`;
    }
    for (const item of data.tables.notification_outbox) {
      const d = item.row;
      if (!["email", "ntfy"].includes(d.channel)) {
        throw new Error("Legacy SMS history needs explicit migration mapping");
      }
      await tx`insert into notification_outbox(id,occurrence_id,user_id,channel,state,attempts,next_attempt_at,provider_id,last_error,created_at,updated_at)
    values(${d.id},${d.occurrence_id},${d.user_id},${d.channel},${
        d.state === "claimed" ? "queued" : d.state
      },${d.attempts},${d.next_attempt_at},${d.provider_id},${d.last_error},${d.created_at},${d.updated_at}) on conflict(id) do nothing`;
    }
    for (const item of data.tables.rule_evaluation_state) {
      const s = item.row;
      await tx`insert into rule_evaluation_state(rule_id,bucket,status,details,updated_at) values(${s.rule_id},${s.bucket},${s.status},${
        tx.json(s.details)
      },${s.updated_at})
    on conflict(rule_id) do update set bucket=excluded.bucket,status=excluded.status,details=excluded.details,updated_at=excluded.updated_at`;
    }
    for (const item of data.tables.detector_models) {
      const m = item.row;
      await tx`insert into detector_models(asset,horizon_minutes,model,expires_at) values(${m.asset},${m.horizon_minutes},${
        tx.json(m)
      },${m.expires_at})
    on conflict(asset,horizon_minutes) do update set model=excluded.model,expires_at=excluded.expires_at where detector_models.expires_at<excluded.expires_at`;
    }
    for (const item of data.tables.volatility_states) {
      const s = item.row;
      await tx`insert into volatility_states(asset,state) values(${s.asset},${
        tx.json(s)
      }) on conflict(asset) do nothing`;
    }
  });
  console.log(
    "Imported rules and delivery history; local evaluation remains paused.",
  );
} finally {
  await store.close();
}
