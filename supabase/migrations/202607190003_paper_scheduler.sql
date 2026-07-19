create table public.paper_processor_lease (
  singleton boolean primary key default true check (singleton),
  bucket timestamptz,
  lease_until timestamptz
);

insert into public.paper_processor_lease (singleton) values (true);
alter table public.paper_processor_lease enable row level security;
revoke all on table public.paper_processor_lease from public, anon, authenticated;
grant all privileges on table public.paper_processor_lease to service_role;

create or replace function public.claim_paper_processor_bucket(p_bucket timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare lease_row public.paper_processor_lease%rowtype;
begin
  select * into lease_row from public.paper_processor_lease where singleton for update;

  if exists (select 1 from public.paper_processor_runs where bucket = p_bucket) then
    return false;
  end if;

  if lease_row.lease_until is not null and lease_row.lease_until > now() then
    insert into public.paper_processor_runs (bucket, state, finished_at, lag_seconds, details)
    values (p_bucket, 'overlap', now(), greatest(0, extract(epoch from now() - p_bucket)::integer),
      jsonb_build_object('activeBucket', lease_row.bucket));
    return false;
  end if;

  update public.paper_processor_lease
  set bucket = p_bucket, lease_until = now() + interval '30 seconds'
  where singleton;
  insert into public.paper_processor_runs (bucket, state, lease_until, lag_seconds)
  values (p_bucket, 'claimed', now() + interval '30 seconds',
    greatest(0, extract(epoch from now() - p_bucket)::integer));
  return true;
end;
$$;

create or replace function public.finish_paper_processor_bucket(
  p_bucket timestamptz,
  p_state text,
  p_metrics jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_state not in ('succeeded', 'partial', 'failed') then
    raise exception 'invalid processor state';
  end if;
  update public.paper_processor_runs set
    state = p_state,
    finished_at = now(),
    lease_until = null,
    assets_processed = coalesce((p_metrics ->> 'assetsProcessed')::integer, assets_processed),
    accounts_processed = coalesce((p_metrics ->> 'accountsProcessed')::integer, accounts_processed),
    api_weight = coalesce((p_metrics ->> 'apiWeight')::integer, api_weight),
    projected_invocations = coalesce((p_metrics ->> 'projectedInvocations')::integer, projected_invocations),
    reconciliation_failures = coalesce((p_metrics ->> 'reconciliationFailures')::integer, reconciliation_failures),
    details = coalesce(p_metrics -> 'details', details)
  where bucket = p_bucket;
  update public.paper_processor_lease set bucket = null, lease_until = null
  where singleton and bucket = p_bucket;
end;
$$;

revoke all on function public.claim_paper_processor_bucket(timestamptz) from public, anon, authenticated;
revoke all on function public.finish_paper_processor_bucket(timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_paper_processor_bucket(timestamptz) to service_role;
grant execute on function public.finish_paper_processor_bucket(timestamptz, text, jsonb) to service_role;

create or replace function public.revalue_paper_epoch_asset(
  p_epoch_id uuid,
  p_expected_version bigint,
  p_asset text,
  p_mark_price numeric,
  p_input_version text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare current_version bigint;
begin
  select version into current_version from public.paper_account_epochs
  where id = p_epoch_id and state = 'active' for update;
  if current_version is null or current_version <> p_expected_version then return false; end if;

  update public.paper_positions set
    mark_price = p_mark_price,
    input_version = p_input_version,
    updated_at = now()
  where epoch_id = p_epoch_id and asset = p_asset;
  if not found then return true; end if;

  update public.paper_account_summaries summary set
    unrealized_pnl = totals.unrealized,
    equity = summary.cash_balance + totals.isolated_allocations + totals.unrealized,
    total_notional = totals.notional,
    fidelity = 'live',
    reconciled_at = now()
  from (
    select
      coalesce(sum(signed_size * (mark_price - entry_price)), 0)::numeric(38, 6) as unrealized,
      coalesce(sum(abs(signed_size) * mark_price), 0)::numeric(38, 6) as notional,
      coalesce(sum(coalesce(isolated_margin, 0)), 0)::numeric(38, 6) as isolated_allocations
    from public.paper_positions where epoch_id = p_epoch_id
  ) totals
  where summary.epoch_id = p_epoch_id;
  update public.paper_account_epochs set version = version + 1 where id = p_epoch_id;
  return true;
end;
$$;

revoke all on function public.revalue_paper_epoch_asset(uuid, bigint, text, numeric, text) from public, anon, authenticated;
grant execute on function public.revalue_paper_epoch_asset(uuid, bigint, text, numeric, text) to service_role;

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
  perform cron.unschedule(jobid) from cron.job where jobname = 'hyperdata-process-paper';
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
