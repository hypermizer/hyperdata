create or replace function public.claim_calibration_jobs(p_limit integer default 5)
returns setof public.calibration_jobs
language sql
security definer
set search_path = public
as $$
  with due as (
    select asset, horizon_minutes
    from public.calibration_jobs
    where (state in ('queued', 'failed', 'complete') and available_at <= now())
       or (state = 'claimed' and lease_until < now())
    order by available_at
    for update skip locked
    limit greatest(1, least(p_limit, 20))
  )
  update public.calibration_jobs j
  set state = 'claimed', lease_until = now() + interval '2 minutes', attempts = attempts + 1
  from due
  where j.asset = due.asset and j.horizon_minutes = due.horizon_minutes
  returning j.*;
$$;

revoke all on function public.claim_calibration_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_calibration_jobs(integer) to service_role;
