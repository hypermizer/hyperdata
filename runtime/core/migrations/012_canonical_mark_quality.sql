create function public.mark_five_minute_volatility(p_asset text) returns double precision language sql stable security invoker set search_path=public as $$
 select coalesce(percentile_cont(0.5)within group(order by abs((price/previous_price-1)*100)::double precision*sqrt(300.0/elapsed)),0) from (
 select price,lag(price)over(order by observed_at)previous_price,extract(epoch from observed_at-lag(observed_at)over(order by observed_at))elapsed
 from mark_price_samples where asset=p_asset and observed_at>=statement_timestamp()-interval '90 minutes'
 ) returns where elapsed>0 and elapsed<=600 and previous_price>0;
$$;
revoke all on function public.mark_five_minute_volatility(text) from public,anon;
grant execute on function public.mark_five_minute_volatility(text) to authenticated,service_role;
create or replace function public.asset_mark_reference_snapshot() returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object('asOf',(select to_char(min(checked_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from mark_reference_coverage c join mark_history_assets a using(asset) where a.active),'rows',coalesce(jsonb_agg(jsonb_build_object('asset',asset,'mark_history',points,'five_minute_volatility',mark_five_minute_volatility(asset))),'[]')) from (
 select a.asset,coalesce(jsonb_agg(jsonb_build_object('time',extract(epoch from c.reference_at)*1000,'price',c.price,'source',c.source,'horizon',c.horizon) order by c.reference_at) filter(where c.reference_at is not null),'[]')points
 from mark_history_assets a left join mark_reference_coverage c using(asset) where a.active group by a.asset
 ) rows;
$$;
-- Correct observation-based discovery dates where the archive proves an older market history.
update asset_analytics_cache c set first_seen_at=least(c.first_seen_at,history.oldest)
from(select asset,min(observed_at)oldest from mark_price_samples group by asset)history
where c.asset=history.asset and(c.first_seen_at is null or c.first_seen_at>history.oldest);
notify pgrst,'reload schema';
