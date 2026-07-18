begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now());

insert into public.alert_rules (id, user_id, asset, detector, configuration)
values ('10000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000021', 'xyz:ORCL', 'large_move',
  '{"direction":"either","horizon_minutes":5,"tail_percentile":0.995,"minimum_move_percent":0}');

select lives_ok($$select public.record_alert_occurrence('10000000-0000-0000-0000-000000000021', '2026-07-18 12:00:00+00', 101, 'underlying_move', '{}')$$,
  'continuous rule records the first qualifying minute');
select lives_ok($$select public.record_alert_occurrence('10000000-0000-0000-0000-000000000021', '2026-07-18 12:01:00+00', 102, 'underlying_move', '{}')$$,
  'continuous rule records the next qualifying minute');
select lives_ok($$select public.record_alert_occurrence('10000000-0000-0000-0000-000000000021', '2026-07-18 12:00:00+00', 101, 'underlying_move', '{}')$$,
  'same-minute replay completes idempotently');
select is((select count(*)::integer from public.alert_occurrences), 2, 'same-minute replay creates no duplicate occurrence');
select is((select count(*)::integer from public.notification_outbox), 2, 'each qualifying minute has one outbox row');
select is((select enabled from public.alert_rules where id = '10000000-0000-0000-0000-000000000021'), true, 'continuous rule stays enabled');

select * from finish();
rollback;
