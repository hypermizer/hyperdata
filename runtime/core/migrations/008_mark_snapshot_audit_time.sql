create or replace function public.asset_mark_reference_snapshot() returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object('asOf',(select min(checked_at) from mark_reference_coverage c join mark_history_assets a using(asset) where a.active),'rows',coalesce(jsonb_agg(jsonb_build_object('asset',asset,'mark_history',points)),'[]')) from (
 select a.asset,coalesce(jsonb_agg(jsonb_build_object('time',extract(epoch from c.reference_at)*1000,'price',c.price,'source',c.source,'horizon',c.horizon) order by c.reference_at) filter(where c.reference_at is not null),'[]')points
 from mark_history_assets a left join mark_reference_coverage c using(asset) where a.active group by a.asset
 ) rows;
$$;
notify pgrst,'reload schema';
