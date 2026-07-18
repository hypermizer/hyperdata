create or replace function public.claim_monitor_bucket(p_bucket timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare claimed boolean;
begin
  insert into public.monitor_runs (bucket, state, lease_until)
  values (p_bucket, 'claimed', now() + interval '55 seconds')
  on conflict (bucket) do update
    set state = 'claimed', started_at = now(), finished_at = null,
        lease_until = now() + interval '55 seconds', details = '{}'::jsonb
    where public.monitor_runs.state = 'claimed' and public.monitor_runs.lease_until < now()
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.finalize_outbox(
  p_id uuid,
  p_state text,
  p_provider_id text default null,
  p_error text default null,
  p_next_attempt_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare changed boolean;
begin
  if p_state not in ('sent', 'retry_wait', 'ambiguous', 'failed') then raise exception 'invalid outbox state'; end if;
  update public.notification_outbox
  set state = p_state, provider_id = p_provider_id, last_error = left(p_error, 500),
      next_attempt_at = coalesce(p_next_attempt_at, next_attempt_at), lease_until = null
  where id = p_id and state = 'claimed'
  returning true into changed;
  return coalesce(changed, false);
end;
$$;

revoke all on function public.claim_monitor_bucket(timestamptz) from public, anon, authenticated;
revoke all on function public.finalize_outbox(uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_monitor_bucket(timestamptz) to service_role;
grant execute on function public.finalize_outbox(uuid, text, text, text, timestamptz) to service_role;
