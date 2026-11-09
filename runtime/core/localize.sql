-- Hosted cron and outbound SQL HTTP are deliberately unavailable locally.
-- Only the systemd processors may schedule work; the alert database is separate.
do $$
declare f record;
begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace
 and proname in ('configure_hyperliquid_account_cron','configure_legacy_listener_cron','configure_listener_cron','configure_paper_cron') loop
   execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
revoke create on schema public from public,anon,authenticated,service_role;
revoke all on schema auth from public,anon;
grant usage on schema auth,extensions to authenticated,service_role;
-- These source rows are historical only. Delivery runs exclusively in hyperdata.
update public.alert_runtime_destination set active=true;

-- Baseline dumps contain DDL only; a fresh install still needs its singleton lease.
insert into public.paper_processor_lease(singleton) values(true) on conflict(singleton) do nothing;
