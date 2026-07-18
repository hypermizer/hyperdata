create or replace function public.configure_listener_cron()
returns void
language plpgsql
security definer
set search_path = public, cron, vault
as $$
declare
  project_url text;
  service_key text;
  monitor_secret text;
begin
  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into monitor_secret from vault.decrypted_secrets where name = 'monitor_secret';

  if project_url is null or service_key is null or monitor_secret is null then
    raise exception 'Vault secrets project_url, service_role_key, and monitor_secret are required';
  end if;

  perform cron.unschedule(jobid) from cron.job
  where jobname in ('hyperdata-monitor-market', 'hyperdata-rebuild-calibrations', 'hyperdata-deliver-alerts', 'hyperdata-prune-listener');

  perform cron.schedule(
    'hyperdata-monitor-market', '* * * * *',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := jsonb_build_object('scheduled_at', now()))$job$,
      project_url || '/functions/v1/monitor-market',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', monitor_secret, 'Content-Type', 'application/json')::text)
  );
  perform cron.schedule(
    'hyperdata-rebuild-calibrations', '*/15 * * * *',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb)$job$,
      project_url || '/functions/v1/rebuild-calibrations',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', monitor_secret, 'Content-Type', 'application/json')::text)
  );
  perform cron.schedule(
    'hyperdata-deliver-alerts', '* * * * *',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb)$job$,
      project_url || '/functions/v1/deliver-alerts',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', monitor_secret, 'Content-Type', 'application/json')::text)
  );
  perform cron.schedule('hyperdata-prune-listener', '17 3 * * *', 'select public.prune_listener_history()');
end;
$$;

revoke all on function public.configure_listener_cron() from public, anon, authenticated;
grant execute on function public.configure_listener_cron() to service_role;
