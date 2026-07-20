create or replace function public.prune_paper_diagnostics()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare input_count integer;
declare run_count integer;
begin
  delete from public.paper_market_inputs where created_at < now() - interval '7 days';
  get diagnostics input_count = row_count;
  delete from public.paper_processor_runs where bucket < now() - interval '30 days';
  get diagnostics run_count = row_count;
  return jsonb_build_object('marketInputs', input_count, 'processorRuns', run_count);
end;
$$;

revoke all on function public.prune_paper_diagnostics() from public, anon, authenticated;
grant execute on function public.prune_paper_diagnostics() to service_role;

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
  sum(reconciliation_failures) filter (where bucket >= now() - interval '24 hours') as reconciliation_failures_24h
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
