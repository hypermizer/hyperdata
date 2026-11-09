-- A completed gap is not replayed after a later outage. Pending gaps retain their original start.
create or replace function public.queue_asset_history_repairs(p_assets text[] default null) returns integer language plpgsql security definer set search_path=public as $$
declare total integer;
begin
 insert into market_history_backfills(asset,from_ms)
 select asset,greatest(extract(epoch from now()-interval '7 days')::bigint*1000,
 coalesce((price_history->-1->>'time')::bigint-360000,0))
 from asset_analytics_cache where (p_assets is null or asset=any(p_assets)) and coalesce((price_history->-1->>'time')::bigint,0)<extract(epoch from now()-interval '2 minutes')::bigint*1000
 on conflict(asset) do update set from_ms=excluded.from_ms,completed_at=null,retry_after=now()
 where market_history_backfills.completed_at is not null;
 get diagnostics total=row_count;return total;
end $$;
revoke all on function public.queue_asset_history_repairs(text[]) from public,anon,authenticated;
grant execute on function public.queue_asset_history_repairs(text[]) to service_role;
notify pgrst,'reload schema';
