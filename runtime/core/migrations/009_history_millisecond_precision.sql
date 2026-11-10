-- Preserve observations within the current fractional second. Integer-second casts can round them out of the retained range.
create or replace function public.merge_asset_price_history(p_asset text,p_points jsonb,p_observed_at timestamptz)
returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
 if p_asset !~ '^[a-zA-Z0-9_.:-]+$' or jsonb_typeof(p_points)<>'array' or jsonb_array_length(p_points)>10000 or p_observed_at>now()+interval '1 minute' then
 raise exception 'Invalid history repair' using errcode='22023';end if;
 insert into asset_analytics_cache as cache(asset,price_history,history_updated_at)
 values(p_asset,'[]',p_observed_at) on conflict(asset) do nothing;
 update asset_analytics_cache cache set price_history=(
 select coalesce(jsonb_agg(jsonb_build_object('time',time_ms,'price',price) order by time_ms),'[]') from (
 select distinct on(case when time_ms<extract(epoch from now()-interval '25 hours')::bigint*1000 then floor(time_ms::numeric/3600000) else time_ms end) time_ms,price
 from (
 select (x->>'time')::bigint as time_ms,(x->>'price')::numeric as price,1 as priority from jsonb_array_elements(cache.price_history)x
 union all
 select (x->>'time')::bigint,(x->>'price')::numeric,0 from jsonb_array_elements(p_points)x
 ) points where time_ms between extract(epoch from now()-interval '31 days')::bigint*1000 and floor(extract(epoch from now())*1000)::bigint and price>0
 order by case when time_ms<extract(epoch from now()-interval '25 hours')::bigint*1000 then floor(time_ms::numeric/3600000) else time_ms end,time_ms desc,priority desc
 ) retained),history_updated_at=greatest(cache.history_updated_at,p_observed_at)
 where cache.asset=p_asset;
 get diagnostics affected=row_count;
 update market_history_backfills set completed_at=now(),last_error=null where asset=p_asset;
 return affected;
end $$;

notify pgrst,'reload schema';
