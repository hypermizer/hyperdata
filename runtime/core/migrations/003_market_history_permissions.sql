-- The migrated database retained permissive provider-era default grants. Narrow
-- all new operational relations explicitly, in addition to their RLS policies.
revoke all on public.market_history_state,public.market_history_backfills,public.market_history_repair_queue from public,anon,authenticated;
grant select on public.market_history_state,public.market_history_backfills to authenticated;
grant all on public.market_history_state,public.market_history_backfills to service_role;
grant select on public.market_history_repair_queue to service_role;
alter view public.market_history_repair_queue set(security_invoker=true);
notify pgrst,'reload schema';
