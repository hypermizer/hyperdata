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
