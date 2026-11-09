-- Let the persistent listener claim iPhone deliveries from its dedicated egress.
-- Generic Edge drains remain a fallback and share the same delivery leases.
drop function public.claim_outbox(integer);
create function public.claim_outbox(p_limit integer default 20, p_channel text default null)
returns setof public.notification_outbox language sql security definer set search_path = public as $$
  with due as (
    select id from public.notification_outbox
    where (p_channel is null or channel = p_channel) and (
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
