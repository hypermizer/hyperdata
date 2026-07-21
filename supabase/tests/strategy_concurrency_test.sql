begin;
create extension if not exists pgtap with schema extensions;
select plan(8);
select public.configure_paper_mutation_access(true);
select public.configure_strategy_mutation_access(true);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000221','00000000-0000-0000-0000-000000000000','authenticated','authenticated','jasonblick@zohomail.com','',now(),'{}','{}',now(),now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000221","email":"jasonblick@zohomail.com","role":"authenticated"}',true);
select public.create_paper_account('Controller',5000);
select public.create_dual_rsi_strategy('Controller strategy',10);
select public.create_strategy_assignment((select id from public.strategy_definitions),(select id from public.paper_accounts),'BTC',10);
select public.set_strategy_assignment_state((select id from public.strategy_assignments),'warming');

select throws_ok(
  $$with inserted as (select public.create_strategy_assignment((select id from public.strategy_definitions),(select id from public.paper_accounts),'BTC',10) id) select public.set_strategy_assignment_state(id,'warming') from inserted$$,
  '23505',null,'only one enabled controller may own an epoch asset'
);

set local role service_role;
insert into public.strategy_evaluations(assignment_id,five_minute_close,decision)
values((select id from public.strategy_assignments),date_trunc('minute',now()),'warming');
select throws_ok(
  $$insert into public.strategy_evaluations(assignment_id,five_minute_close,decision) values((select id from public.strategy_assignments),date_trunc('minute',now()),'warming')$$,
  '23505',null,'an evaluation bucket is recorded once'
);
select throws_ok(
  $$insert into public.paper_commands(epoch_id,idempotency_key,expected_version,canonical_result) values((select epoch_id from public.strategy_assignments),'manual:1',0,'{"order":{"asset":"BTC"}}')$$,
  'P0001','asset is controlled by an enabled strategy; pause it before placing a manual order','manual owned-asset command is blocked'
);
select lives_ok(
  $$insert into public.paper_commands(epoch_id,idempotency_key,expected_version,canonical_result) values((select epoch_id from public.strategy_assignments),'strategy:entry:1',0,'{"order":{"asset":"BTC"}}')$$,
  'strategy command is admitted'
);
select lives_ok(
  $$insert into public.paper_commands(epoch_id,idempotency_key,expected_version,canonical_result) values((select epoch_id from public.strategy_assignments),'manual:other',0,'{"order":{"asset":"ETH"}}')$$,
  'manual unrelated asset command is admitted'
);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000221","email":"jasonblick@zohomail.com","role":"authenticated"}',true);
select is(public.reset_paper_account((select id from public.paper_accounts)),2,'account reset succeeds');
select is((select state from public.strategy_assignments),'paused','reset disables old epoch assignment');
select is((select degraded_reason from public.strategy_assignments),'account_epoch_reset','reset reason is visible');
select * from finish();
rollback;
