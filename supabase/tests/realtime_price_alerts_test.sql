begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000091', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'price-alert-test@example.test', '', now(), '{}', '{}', now(), now());
insert into public.alert_rules (id,user_id,asset,detector,configuration,delivery)
values ('10000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000091','BTC','fixed_price','{"direction":"above","target":100}','email');
select is((select delivery from public.alert_rules where id='10000000-0000-0000-0000-000000000091'),'both','legacy clients also get both channels');
select is(public.record_alert_occurrence('10000000-0000-0000-0000-000000000091',now(),99,'fixed_price','{}'),null::uuid,'database rejects false threshold');
select is(public.record_alert_occurrence('10000000-0000-0000-0000-000000000091',now(),100,'fixed_price','{"ruleUpdatedAt":"2000-01-01T00:00:00Z"}'),null::uuid,'stale rule revision cannot trigger');
select is(public.record_alert_occurrence('10000000-0000-0000-0000-000000000091',now(),100,'fixed_price','{"observedAt":"2000-01-01T00:00:00Z"}'),null::uuid,'tick before rule creation cannot trigger');
select isnt(public.record_alert_occurrence('10000000-0000-0000-0000-000000000091',now(),100,'fixed_price',jsonb_build_object('observedAt',clock_timestamp())),null::uuid,'inclusive equality triggers');
select is((select count(*)::integer from public.notification_outbox where user_id='00000000-0000-0000-0000-000000000091'),2,'one independent record per channel');
select is((select status from public.rule_evaluation_state where rule_id='10000000-0000-0000-0000-000000000091'),'triggered','triggered state committed with occurrence');
select is(public.record_alert_occurrence('10000000-0000-0000-0000-000000000091',clock_timestamp(),101,'fixed_price','{}'),null::uuid,'competing engine cannot retrigger disabled rule');
-- Rearm immediately in the same fallback time bucket; a new observation is a new occurrence.
update public.alert_rules set enabled=true where id='10000000-0000-0000-0000-000000000091';
select isnt(public.record_alert_occurrence('10000000-0000-0000-0000-000000000091',now(),100,'fixed_price',jsonb_build_object('observedAt',clock_timestamp())),null::uuid,'rearm can trigger again within same 15-second bucket');
select is((select count(*)::integer from public.alert_occurrences where user_id='00000000-0000-0000-0000-000000000091'),2,'two distinct arming cycles');
-- Isolate claim tests from any historical production rows during rollback rehearsal.
create temporary table test_phone_claim as select * from public.claim_outbox(100,'ntfy');
select is((select bool_and(channel='ntfy') from test_phone_claim),true,'phone worker cannot claim email deliveries');
create temporary table test_claim as select * from public.claim_outbox(100);
select is(public.finalize_outbox((select id from test_claim where user_id='00000000-0000-0000-0000-000000000091' limit 1),'sent',p_attempt:=999),false,'stale worker cannot finalize another lease');
select is(public.finalize_outbox((select id from test_claim where user_id='00000000-0000-0000-0000-000000000091' limit 1),'sent',p_attempt:=1),true,'current claim can finalize');
select is(public.finalize_outbox((select id from test_claim where user_id='00000000-0000-0000-0000-000000000091' limit 1),'failed',p_attempt:=1),false,'completed delivery cannot be overwritten');
select * from finish();
rollback;
