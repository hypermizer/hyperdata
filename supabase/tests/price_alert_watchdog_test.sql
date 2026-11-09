begin;
create extension if not exists pgtap with schema extensions;
select plan(5);
-- Rollback-only fixture: isolate service state without delivering any notice.
delete from public.price_stream_health;
update public.price_alert_watchdog set problem=null,notify_after=now()-interval '1 second';
select ok(public.claim_price_alert_incident() like 'Live price listener is offline%', 'independent monitor detects a stopped worker');
select is(public.claim_price_alert_incident(),null::text,'watchdog throttles repeated outage notices');
insert into public.price_stream_health(worker_id,connected,last_market_at,rules_refreshed_at)
values('watchdog-test',true,now(),now());
select is(public.claim_price_alert_incident(),'Price alert monitoring and delivery have recovered.','recovery produces a distinct notice');
select is(public.claim_price_alert_incident(),null::text,'healthy worker produces no repeated notice');
update public.price_stream_health set unhealthy_since=now()-interval '60 seconds';
select ok(public.claim_price_alert_incident() like 'Live price listener is offline%', 'persistent asset staleness triggers an incident even with fresh heartbeat');
select * from finish();
rollback;
