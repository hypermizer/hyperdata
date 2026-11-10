-- Recover an approaching reference gap before it becomes a missing dot. Respect no-data/provider retry cooldowns.
create or replace function public.refresh_mark_reference_coverage() returns jsonb language plpgsql security definer set search_path=public as $$
declare total integer;ready integer;
begin
 insert into mark_reference_coverage(asset,horizon,checked_at,reference_at,price,source)
 select a.asset,h.minutes,statement_timestamp(),s.observed_at,s.price,s.source
 from mark_history_assets a cross join (values(10080),(1440),(360),(60),(30),(10),(5))h(minutes)
 left join lateral(select observed_at,price,source from mark_price_samples p where p.asset=a.asset and p.observed_at<=statement_timestamp()-make_interval(mins=>h.minutes) and p.observed_at>=statement_timestamp()-make_interval(mins=>h.minutes)-interval '2 minutes' order by p.observed_at desc limit 1)s on true where a.active
 on conflict(asset,horizon) do update set checked_at=excluded.checked_at,reference_at=excluded.reference_at,price=excluded.price,source=excluded.source;
 -- Repair every missing asset/window, with no favourite/watchlist ordering.
 insert into mark_archive_jobs(asset,band,start_ms,end_ms)
 select asset,band,extract(epoch from statement_timestamp()-make_interval(mins=>start_minutes)-interval '2 minutes')::bigint*1000,
 extract(epoch from least(statement_timestamp(),statement_timestamp()-make_interval(mins=>start_minutes)+interval '6 hours'))::bigint*1000 from (
 select distinct c.asset,case when c.horizon<=60 then 60 else c.horizon end as band,case when c.horizon<=60 then 65 else c.horizon end as start_minutes
 from mark_reference_coverage c join mark_history_assets a using(asset) where a.active and (c.reference_at is null or not exists(
 select 1 from mark_price_samples future
 where future.asset=c.asset and future.observed_at<=statement_timestamp()-make_interval(mins=>c.horizon-least(15,c.horizon-1))
 and future.observed_at>=statement_timestamp()-make_interval(mins=>c.horizon-least(15,c.horizon-1))-interval '2 minutes'
))
 ) gaps on conflict(asset,band) do update set start_ms=excluded.start_ms,end_ms=excluded.end_ms,cursor=null,state='pending',retry_at=now(),last_error=null
 where mark_archive_jobs.state='complete' and mark_archive_jobs.retry_at<=now();
 select count(*),count(reference_at) into total,ready from mark_reference_coverage c join mark_history_assets a using(asset) where a.active;
 return jsonb_build_object('total',total,'ready',ready,'missing',total-ready);
end $$;

notify pgrst,'reload schema';
