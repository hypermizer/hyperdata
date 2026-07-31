const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_ID;
const monitorSecret = process.env.MONITOR_SECRET;
const deliveryEnabled = process.env.DELIVERY_ENABLED === "true";
if (!token || !projectRef || !monitorSecret) {
  throw new Error("SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_ID, and MONITOR_SECRET are required");
}

const managementHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const fetchWithTimeout = (url, options = {}, timeout = 30_000) => fetch(url, {
  ...options,
  signal: options.signal ?? AbortSignal.timeout(timeout),
});
const keysResponse = await fetchWithTimeout(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/api-keys`, { headers: managementHeaders });
if (!keysResponse.ok) throw new Error(`Unable to retrieve project API keys (${keysResponse.status})`);
const keys = await keysResponse.json();
const serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key;
if (!serviceRoleKey) throw new Error("Project service-role key was unavailable");

const queryUrl = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`;
async function query(sql) {
  let lastFailure;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(queryUrl, {
        method: "POST",
        headers: managementHeaders,
        body: JSON.stringify({ query: sql, read_only: true }),
      });
    } catch (error) {
      lastFailure = error;
    }
    if (response) {
      const body = await response.text();
      if (response.ok) {
        const parsed = body ? JSON.parse(body) : [];
        return Array.isArray(parsed) ? parsed : parsed.result ?? [];
      }
      lastFailure = new Error(`Alert verification query failed (${response.status}): ${body.slice(0, 300)}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastFailure;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
  throw lastFailure;
}

const [monitorHealth = {}] = await query(`
  select max(bucket) filter (where state in ('succeeded', 'partial')) as latest_completed_bucket,
    extract(epoch from now() - max(bucket) filter (where state in ('succeeded', 'partial')))::integer as latest_completed_age_seconds,
    count(*) filter (where state = 'succeeded' and bucket > now() - interval '24 hours')::integer as succeeded_24h,
    count(*) filter (where state = 'partial' and bucket > now() - interval '24 hours')::integer as partial_24h,
    count(*) filter (where state = 'failed' and bucket > now() - interval '24 hours')::integer as failed_24h
  from public.monitor_runs
`);
if (!monitorHealth.latest_completed_bucket || Number(monitorHealth.latest_completed_age_seconds) > 180) {
  throw new Error(`Alert monitor is stale: ${JSON.stringify(monitorHealth)}`);
}
console.log(`Alert monitor health: ${JSON.stringify(monitorHealth)}`);

const [ruleHealth = {}] = await query(`
  select count(*)::integer as enabled_rules,
    count(*) filter (where state.rule_id is null
      or state.updated_at < now() - interval '3 minutes'
      or state.status = 'error')::integer as unhealthy_rules,
    coalesce(jsonb_agg(jsonb_build_object(
      'asset', rule.asset,
      'detector', rule.detector,
      'rule_created_at', rule.created_at,
      'evaluation_status', state.status,
      'evaluation_updated_at', state.updated_at
    )) filter (where state.rule_id is null
      or state.updated_at < now() - interval '3 minutes'
      or state.status = 'error'), '[]'::jsonb) as unhealthy_rule_details
  from public.alert_rules rule
  left join public.rule_evaluation_state state on state.rule_id = rule.id
  where rule.enabled and rule.deleted_at is null
`);
if (Number(ruleHealth.unhealthy_rules) > 0) {
  throw new Error(`Enabled alert rules are not being evaluated reliably: ${JSON.stringify(ruleHealth)}`);
}
console.log(`Alert rule evaluation health: ${JSON.stringify(ruleHealth)}`);

const [calibrationHealth = {}] = await query(`
  select count(*)::integer as enabled_large_move_rules,
    count(*) filter (where not exists (
      select 1 from public.detector_models model
      where model.asset = rule.asset
        and model.horizon_minutes = (rule.configuration ->> 'horizon_minutes')::integer
        and model.detector = 'large_move'
        and model.sample_count >= 100
        and model.expires_at > now()
    ))::integer as rules_still_calibrating,
    count(*) filter (where rule.created_at < now() - interval '1 hour' and not exists (
      select 1 from public.detector_models model
      where model.asset = rule.asset
        and model.horizon_minutes = (rule.configuration ->> 'horizon_minutes')::integer
        and model.detector = 'large_move'
        and model.sample_count >= 100
        and model.expires_at > now()
    ))::integer as stale_calibrating_rules
  from public.alert_rules rule
  where rule.enabled and rule.deleted_at is null and rule.detector = 'large_move'
`);
if (Number(calibrationHealth.stale_calibrating_rules) > 0) {
  throw new Error(`Large-move rules remained uncalibrated for over one hour: ${JSON.stringify(calibrationHealth)}`);
}
console.log(`Large-move calibration health: ${JSON.stringify(calibrationHealth)}`);

async function outboxSummary() {
  return query(`
    select state, count(*)::integer as count, min(created_at) as oldest
    from public.notification_outbox
    group by state
    order by state
  `);
}

const before = await outboxSummary();
console.log(`Alert outbox before delivery check: ${JSON.stringify(before)}`);
if (deliveryEnabled) {
  const [{ due = 0 } = {}] = await query(`
    select count(*)::integer as due
    from public.notification_outbox
    where (state in ('queued', 'retry_wait') and next_attempt_at <= now())
       or (state = 'claimed' and lease_until < now())
  `);
  if (due > 0) {
    const response = await fetchWithTimeout(`https://${projectRef}.supabase.co/functions/v1/deliver-alerts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "content-type": "application/json",
        "x-monitor-secret": monitorSecret,
      },
      body: "{}",
    }, 45_000);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Alert delivery smoke returned ${response.status}: ${JSON.stringify(result).slice(0, 300)}`);
    const outcomes = Array.isArray(result.outcomes) ? result.outcomes : [];
    if (!outcomes.length || outcomes.some(({ state }) => state !== "sent")) {
      throw new Error(`Alert delivery smoke did not confirm every claimed notification: ${JSON.stringify(outcomes)}`);
    }
    console.log(`Alert delivery smoke: ${outcomes.length} notification(s) confirmed sent`);
  } else {
    console.log("Alert delivery smoke: no queued notification was available; delivery endpoint was not invoked");
  }
}
console.log(`Alert outbox after delivery check: ${JSON.stringify(await outboxSummary())}`);
