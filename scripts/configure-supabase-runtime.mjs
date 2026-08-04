const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_ID;
const monitorSecret = process.env.MONITOR_SECRET;
const paperSchedulerSecret = process.env.PAPER_SCHEDULER_SECRET;
const paperProcessorEnabled = process.env.PAPER_PROCESSOR_ENABLED === "true";
const paperTradingEnabled = process.env.PAPER_TRADING_ENABLED === "true";
const strategyCommandEnabled = process.env.STRATEGY_COMMAND_ENABLED === "true";
if (!token || !projectRef || !monitorSecret || (paperProcessorEnabled && !paperSchedulerSecret)) {
  throw new Error("SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_ID, and MONITOR_SECRET are required; PAPER_SCHEDULER_SECRET is required when the paper processor is enabled");
}

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const fetchWithTimeout = (url, options = {}, timeout = 30_000) => fetch(url, {
  ...options,
  signal: options.signal ?? AbortSignal.timeout(timeout),
});
const keysResponse = await fetchWithTimeout(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/api-keys`, { headers });
if (!keysResponse.ok) throw new Error(`Unable to retrieve project API keys (${keysResponse.status})`);
const keys = await keysResponse.json();
const serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key;
if (!serviceRoleKey) throw new Error("Project service-role key was unavailable");

const queryUrl = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`;
async function query(sql, parameters = []) {
  let lastFailure;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(queryUrl, { method: "POST", headers, body: JSON.stringify({ query: sql, parameters, read_only: false }) });
    } catch (error) {
      lastFailure = error;
    }
    if (response) {
      const body = await response.text();
      if (response.ok) return body ? JSON.parse(body) : [];
      lastFailure = new Error(`Runtime configuration query failed (${response.status}): ${body.slice(0, 300)}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastFailure;
    }
    if (attempt < 3) await wait(1_000 * 2 ** attempt);
  }
  throw lastFailure;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const secrets = [
  ["project_url", `https://${projectRef}.supabase.co`],
  ["service_role_key", serviceRoleKey],
  ["monitor_secret", monitorSecret],
];
if (paperSchedulerSecret) secrets.push(["paper_scheduler_secret", paperSchedulerSecret]);
for (const [name, value] of secrets) {
  await query("delete from vault.secrets where name = $1", [name]);
  await query("select vault.create_secret($1, $2)", [value, name]);
}
await query("select public.configure_listener_cron()");
const accountHealthWindowStartedAt = new Date().toISOString();
await query("select public.configure_hyperliquid_account_cron()");
let accountHealth = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const result = await query(`
    select source.address, source.fills_cursor_ms, source.last_success_at, source.last_error,
      (select count(*)::integer from public.hyperliquid_account_fills fill
        where fill.user_id = source.user_id and fill.account_address = source.address) as fill_count
    from public.hyperliquid_account_sources source
    where source.active
    order by source.created_at
    limit 1
  `);
  accountHealth = (Array.isArray(result) ? result : result.result ?? [])[0] ?? null;
  const completedInWindow = accountHealth?.last_success_at &&
    Date.parse(accountHealth.last_success_at) >= Date.parse(accountHealthWindowStartedAt);
  if (completedInWindow && !accountHealth.last_error && accountHealth.fills_cursor_ms !== null && Number(accountHealth.fill_count) > 0) break;
  await wait(5_000);
}
const accountSyncHealthy = accountHealth?.last_success_at &&
  Date.parse(accountHealth.last_success_at) >= Date.parse(accountHealthWindowStartedAt) &&
  !accountHealth.last_error && accountHealth.fills_cursor_ms !== null && Number(accountHealth.fill_count) > 0;
if (!accountSyncHealthy) {
  await query("select cron.unschedule(jobid) from cron.job where jobname = 'hyperdata-sync-account'");
  throw new Error(`Account sync did not complete a healthy production run: ${JSON.stringify(accountHealth)}`);
}
console.log(`Account sync health verified: ${Number(accountHealth.fill_count)} fill(s), cursor ${accountHealth.fills_cursor_ms}`);
const paperHealthWindowStartedAt = new Date().toISOString();
await query("select public.configure_paper_cron($1)", [paperProcessorEnabled]);
await query("select public.configure_paper_mutation_access($1)", [paperTradingEnabled]);
await query("select public.configure_strategy_mutation_access($1)", [strategyCommandEnabled]);

if (paperProcessorEnabled) {
  let runs = [];
  let recentCompletedRuns = [];
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const result = await query(
      "select state, assets_processed, accounts_processed, reconciliation_failures, details from public.paper_processor_runs where bucket >= $1 order by bucket desc limit 12",
      [paperHealthWindowStartedAt],
    );
    runs = Array.isArray(result) ? result : result.result ?? [];
    recentCompletedRuns = runs.filter((run) => run.state !== "claimed").slice(0, 3);
    const stable = recentCompletedRuns.length === 3 && recentCompletedRuns.every(
      (run) => run.state === "succeeded" && Number(run.reconciliation_failures ?? 0) === 0,
    );
    if (stable) break;
    await wait(5_000);
  }
  if (!runs.length) {
    await query("select public.configure_paper_cron(false)");
    throw new Error("Paper processor did not complete a run during the deployment health window");
  }
  const stable = recentCompletedRuns.length === 3 && recentCompletedRuns.every(
    (run) => run.state === "succeeded" && Number(run.reconciliation_failures ?? 0) === 0,
  );
  if (!stable) {
    await query("select public.configure_paper_cron(false)");
    const observedStates = runs.map((run) => {
      const degradedAssets = Array.isArray(run.details?.degradedAssets) ? run.details.degradedAssets : [];
      const degraded = degradedAssets.map((item) => {
        const asset = String(item?.asset ?? "unknown");
        const reason = String(item?.reason ?? "unknown").replace(/\s+/g, " ").slice(0, 160);
        return `${asset}=${reason}`;
      }).join("|");
      return `${run.state}:${Number(run.reconciliation_failures ?? 0)}${degraded ? `[${degraded}]` : ""}`;
    }).join(", ");
    throw new Error(`Paper processor did not produce three consecutive reconciled successful runs during the deployment health window (observed ${observedStates})`);
  }
  console.log("Paper processor health verified: 3 consecutive reconciled successful runs");
  const riskResult = await query(`
    with active_epochs as (
      select epoch.id
      from public.paper_accounts account
      join public.paper_account_epochs epoch
        on epoch.account_id = account.id and epoch.epoch_number = account.active_epoch
      where account.archived_at is null and epoch.state = 'active'
    ), position_totals as (
      select epoch.id as epoch_id,
        count(position.asset)::integer as position_count,
        count(position.asset) filter (where position.updated_at < now() - interval '45 seconds')::integer as stale_positions,
        coalesce(sum(position.signed_size * (position.mark_price - position.entry_price)), 0)::numeric(38, 6) as unrealized_pnl,
        coalesce(sum(abs(position.signed_size) * position.mark_price), 0)::numeric(38, 6) as total_notional
      from active_epochs epoch
      left join public.paper_positions position on position.epoch_id = epoch.id
      group by epoch.id
    )
    select coalesce(sum(position_count), 0)::integer as active_positions,
      (select count(distinct position.asset)::integer from public.paper_positions position join active_epochs epoch on epoch.id = position.epoch_id) as active_assets,
      coalesce(sum(stale_positions), 0)::integer as stale_positions,
      count(*) filter (where summary.unrealized_pnl <> totals.unrealized_pnl
        or summary.equity <> summary.cash_balance + totals.unrealized_pnl
        or summary.total_notional <> totals.total_notional)::integer as inconsistent_accounts
    from position_totals totals
    join public.paper_account_summaries summary on summary.epoch_id = totals.epoch_id
  `);
  const riskHealth = (Array.isArray(riskResult) ? riskResult : riskResult.result ?? [])[0] ?? {};
  const processedEveryPosition = recentCompletedRuns.every((run) =>
    Number(run.assets_processed ?? 0) >= Number(riskHealth.active_assets ?? 0) &&
    Number(run.accounts_processed ?? 0) >= Number(riskHealth.active_positions ?? 0)
  );
  if (!processedEveryPosition || Number(riskHealth.stale_positions ?? 0) > 0 || Number(riskHealth.inconsistent_accounts ?? 0) > 0) {
    await query("select public.configure_paper_cron(false)");
    throw new Error(`Paper authoritative state verification failed: ${JSON.stringify(riskHealth)}`);
  }
  console.log(`Paper authoritative state verified: ${Number(riskHealth.active_positions ?? 0)} active position(s), no stale marks or P&L inconsistencies`);
}
console.log(`Configured Hyperdata runtime; paper processor ${paperProcessorEnabled ? "enabled" : "disabled"}; paper mutations ${paperTradingEnabled ? "enabled" : "disabled"}; strategy commands ${strategyCommandEnabled ? "enabled" : "disabled"}`);
