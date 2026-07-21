begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
select public.configure_paper_mutation_access(true);
select public.configure_strategy_mutation_access(true);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000000','authenticated','authenticated','jasonblick@zohomail.com','',now(),'{}','{}',now(),now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000201","email":"jasonblick@zohomail.com","role":"authenticated"}',true);
select lives_ok($$select public.create_paper_account('Strategy account',5000)$$,'paper account created');
select lives_ok($$select public.create_dual_rsi_strategy('Dual RSI',10)$$,'strategy and first revision created');
select is((select count(*)::integer from public.strategy_revisions),1,'one immutable revision exists');
select is((select parameters->>'baselineLength' from public.strategy_revisions),'100','baseline contract persists');
select lives_ok($$select public.create_strategy_assignment((select id from public.strategy_definitions),(select id from public.paper_accounts),'xyz:DRAM',10)$$,'paused assignment created');
select is((select state from public.strategy_assignments),'paused','assignment starts paused');
select lives_ok($$select public.set_strategy_assignment_state((select id from public.strategy_assignments),'warming')$$,'assignment explicitly enabled');
select is((select state from public.strategy_assignments),'warming','enabled assignment begins warming');
select lives_ok($$select public.queue_strategy_backtest((select id from public.strategy_revisions),array['xyz:DRAM','xyz:XYZ100','BTC'],now()-interval '7 days',now(),5000)$$,'backtest queued');
select is((select status from public.backtest_runs),'queued','backtest is durable queued work');
set local role service_role;
select throws_ok($$update public.strategy_revisions set parameters='{}'::jsonb$$,'P0001','strategy revisions are immutable','revision updates are rejected');
select * from finish();
rollback;
