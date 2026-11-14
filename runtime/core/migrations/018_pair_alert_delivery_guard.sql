-- Disabled/archived monitors stop queued delivery. Crash recovery also obeys
-- the attempt bound; a crash before acknowledgement cannot retry forever.
create or replace function public.claim_pair_alerts() returns setof pair_alert_outbox language plpgsql security definer set search_path=public as $$
begin
 update pair_alert_outbox o set state='failed',last_error=case when attempts>=6 then 'Delivery attempt limit reached' else 'Pair alert disabled or archived' end,lease_token=null,lease_until=null
 where (o.state='queued' or (o.state='claimed' and o.lease_until<now())) and (o.attempts>=6 or not exists(select 1 from pair_trades p where p.id=o.pair_id and not p.archived and p.config->'alerts' ? o.metric));
 return query with due as(select o.id from pair_alert_outbox o join pair_trades p on p.id=o.pair_id where o.attempts<6 and not p.archived and p.config->'alerts' ? o.metric and ((o.state='queued' and o.next_attempt_at<=now()) or (o.state='claimed' and o.lease_until<now())) order by o.created_at for update of o skip locked limit 10)
 update pair_alert_outbox o set state='claimed',attempts=o.attempts+1,lease_token=extensions.gen_random_uuid(),lease_until=now()+interval '2 minutes' from due where o.id=due.id returning o.*;
end $$;
revoke all on function claim_pair_alerts() from public,anon,authenticated;
grant execute on function claim_pair_alerts() to service_role;
