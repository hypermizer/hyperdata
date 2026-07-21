begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000231','00000000-0000-0000-0000-000000000000','authenticated','authenticated','jasonblick@zohomail.com','',now(),'{}','{}',now(),now());

set local role service_role;
select isnt(public.ensure_strategy_shadow(),null::uuid,'strategy shadow seeds');
select is(public.ensure_strategy_shadow(),(select id from public.strategy_definitions where name='__SHADOW__ DUAL RSI'),'strategy shadow seed is idempotent');
select is((select count(*)::integer from public.strategy_definitions where name='__SHADOW__ DUAL RSI'),1,'one shadow definition exists');
select is((select count(*)::integer from public.strategy_revisions),1,'one immutable shadow revision exists');
select is((select count(*)::integer from public.strategy_assignments),3,'three shadow assets are assigned');
select is((select count(*)::integer from public.strategy_assignments where state='warming'),3,'shadow assignments evaluate without implicit entries');
select is((select count(*)::integer from public.paper_orders),0,'shadow setup emits no paper orders');
select isnt(public.ensure_initial_strategy_backtest(),null::uuid,'initial backtest queues');
select is(public.ensure_initial_strategy_backtest(),(select id from public.backtest_runs),'initial backtest queue is idempotent');
select is((select assets::text from public.backtest_runs),'{xyz:DRAM,xyz:XYZ100,BTC}','initial run covers exact requested assets');
select is((select active_assignments from public.strategy_operational_health),3,'health reports active assignments');
select function_privs_are('public','ensure_strategy_shadow',array[]::text[],'authenticated',array[]::text[],'browser cannot seed service rollout');
select * from finish();
rollback;
