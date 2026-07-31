begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into public.asset_analytics_cache (asset, average_daily_volume, price_history)
values ('xyz:ORCL', 1000, '[{"time":1,"price":100}]'::jsonb);

set local role anon;
select is((select count(*)::integer from public.asset_analytics_cache), 1, 'anonymous browsers can read public market analytics');
select throws_ok(
  $$insert into public.asset_analytics_cache (asset) values ('xyz:BAD')$$,
  '42501', null, 'anonymous browsers cannot write market analytics'
);

set local role authenticated;
select is((select average_daily_volume from public.asset_analytics_cache where asset = 'xyz:ORCL'), 1000::double precision, 'authenticated browsers can read analytics');
select throws_ok(
  $$update public.asset_analytics_cache set average_daily_volume = 1 where asset = 'xyz:ORCL'$$,
  '42501', null, 'authenticated browsers cannot alter analytics'
);

select * from finish();
rollback;
