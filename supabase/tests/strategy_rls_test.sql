begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
select public.configure_paper_mutation_access(true);
select public.configure_strategy_mutation_access(true);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000211','00000000-0000-0000-0000-000000000000','authenticated','authenticated','jasonblick@zohomail.com','',now(),'{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000212','00000000-0000-0000-0000-000000000000','authenticated','authenticated','other@example.com','',now(),'{}','{}',now(),now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000211","email":"jasonblick@zohomail.com","role":"authenticated"}',true);
select public.create_dual_rsi_strategy('Owner strategy',10);
select is((select count(*)::integer from public.strategy_definitions),1,'owner reads definition');
select is((select count(*)::integer from public.strategy_revisions),1,'owner reads revision');
select throws_ok($$insert into public.strategy_definitions(user_id,name,strategy_kind) values(auth.uid(),'Direct','dual_relative_rsi')$$,'42501',null,'owner cannot directly insert');

select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000212","email":"other@example.com","role":"authenticated"}',true);
select is((select count(*)::integer from public.strategy_definitions),0,'other user sees no definition');
select is((select count(*)::integer from public.strategy_revisions),0,'other user sees no revision');
select throws_ok($$select public.create_dual_rsi_strategy('Wrong owner',10)$$,'P0001','not authorized','wrong email cannot create strategy');

set local role anon;
select throws_ok($$select count(*) from public.strategy_definitions$$,'42501',null,'anonymous cannot read strategies');
select * from finish();
rollback;
