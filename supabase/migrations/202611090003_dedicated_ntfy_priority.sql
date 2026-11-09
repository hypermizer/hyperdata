create or replace function public.claim_outbox(p_limit integer default 20, p_channel text default null)
returns setof public.notification_outbox language sql security definer set search_path = public as $$
  with due as (
    select id from public.notification_outbox
    where (p_channel is null or channel = p_channel)
    -- Give the dedicated egress first opportunity before trying shared Edge egress.
    and (p_channel is not null or channel <> 'ntfy' or created_at < now() - interval '10 seconds'
      or not exists (select 1 from public.price_stream_health
        where connected and heartbeat_at > now() - interval '20 seconds'))
    and (
      (state in ('queued', 'retry_wait') and next_attempt_at <= now()) or
      (state = 'claimed' and lease_until < now())
    )
    order by next_attempt_at, created_at for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.notification_outbox o
  set state = 'claimed', lease_until = now() + interval '2 minutes', attempts = attempts + 1
  from due where o.id = due.id returning o.*;
$$;
revoke all on function public.claim_outbox(integer, text) from public, anon, authenticated;
grant execute on function public.claim_outbox(integer, text) to service_role;
