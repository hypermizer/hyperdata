create or replace view public.paper_processor_health
with (security_invoker = true)
as
select
  max(bucket) as latest_bucket,
  max(finished_at) as latest_finished_at,
  count(*) filter (where bucket >= now() - interval '1 hour') as runs_last_hour,
  count(*) filter (where bucket >= now() - interval '1 hour' and state in ('failed', 'partial', 'overlap')) as unhealthy_last_hour,
  max(lag_seconds) filter (where bucket >= now() - interval '1 hour') as max_lag_seconds,
  sum(api_weight) filter (where bucket >= now() - interval '1 hour') as api_weight_last_hour,
  max(projected_invocations) as projected_monthly_invocations,
  sum(reconciliation_failures) filter (where bucket >= now() - interval '24 hours') as reconciliation_failures_24h,
  (array_agg(state order by bucket desc))[1] as latest_state
from public.paper_processor_runs;

revoke all on public.paper_processor_health from public, anon;
grant select on public.paper_processor_health to authenticated, service_role;

create or replace function public.configure_paper_cron(p_enabled boolean default false)
returns void
language plpgsql
security definer
set search_path = public, cron, vault
as $$
declare project_url text;
declare service_key text;
declare scheduler_secret text;
begin
  perform cron.unschedule(jobid) from cron.job
  where jobname in ('hyperdata-process-paper', 'hyperdata-prune-paper');
  perform cron.schedule('hyperdata-prune-paper', '41 3 * * *', 'select public.prune_paper_diagnostics()');
  if not p_enabled then return; end if;

  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into scheduler_secret from vault.decrypted_secrets where name = 'paper_scheduler_secret';
  if project_url is null or service_key is null or scheduler_secret is null then
    raise exception 'paper scheduler Vault secrets are required';
  end if;
  perform cron.schedule(
    'hyperdata-process-paper', '10 seconds',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := jsonb_build_object('scheduled_at', now()))$job$,
      project_url || '/functions/v1/process-paper',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', scheduler_secret, 'Content-Type', 'application/json')::text)
  );
end;
$$;

revoke all on function public.configure_paper_cron(boolean) from public, anon, authenticated;
grant execute on function public.configure_paper_cron(boolean) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'paper_account_epochs'
    ) then
    alter publication supabase_realtime add table public.paper_account_epochs;
  end if;
end;
$$;
