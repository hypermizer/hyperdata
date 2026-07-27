create or replace function public.claim_sign_in_email_delivery(p_now timestamptz default now())
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  limiter public.sign_in_email_limits%rowtype;
begin
  insert into public.sign_in_email_limits(limiter_key, window_started_at)
  values ('owner', p_now)
  on conflict (limiter_key) do nothing;

  select * into limiter
  from public.sign_in_email_limits
  where limiter_key = 'owner'
  for update;

  if p_now >= limiter.window_started_at + interval '1 hour' then
    limiter.window_started_at := p_now;
    limiter.attempt_count := 0;
    limiter.last_sent_at := null;
  end if;

  if limiter.last_sent_at is not null and p_now < limiter.last_sent_at + interval '10 seconds' then
    return 'cooldown';
  end if;
  if limiter.attempt_count >= 20 then
    return 'hourly_limit';
  end if;

  update public.sign_in_email_limits
  set window_started_at = limiter.window_started_at,
      last_sent_at = p_now,
      attempt_count = limiter.attempt_count + 1
  where limiter_key = 'owner';
  return 'claimed';
end;
$$;

revoke all on function public.claim_sign_in_email_delivery(timestamptz) from public, anon, authenticated;
grant execute on function public.claim_sign_in_email_delivery(timestamptz) to service_role;
