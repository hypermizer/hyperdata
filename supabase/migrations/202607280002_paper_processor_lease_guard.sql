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
  set bucket = p_bucket, lease_until = now() + interval '90 seconds'
  where singleton;
  insert into public.paper_processor_runs (bucket, state, lease_until, lag_seconds)
  values (p_bucket, 'claimed', now() + interval '90 seconds',
    greatest(0, extract(epoch from now() - p_bucket)::integer));
  return true;
end;
$$;

revoke all on function public.claim_paper_processor_bucket(timestamptz) from public, anon, authenticated;
grant execute on function public.claim_paper_processor_bucket(timestamptz) to service_role;
