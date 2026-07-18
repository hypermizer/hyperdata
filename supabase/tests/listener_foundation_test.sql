begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()
);

select ok(public.valid_alert_configuration('fixed_price', '{"direction":"above","target":100}'::jsonb), 'valid fixed config');
select ok(not public.valid_alert_configuration('fixed_price', '{"direction":"sideways","target":100}'::jsonb), 'invalid fixed direction');
select ok(public.valid_alert_configuration('large_move', '{"direction":"either","horizon_minutes":5,"tail_percentile":0.995,"minimum_move_percent":0}'::jsonb), 'valid move config');
select ok(not public.valid_alert_configuration('large_move', '{"direction":"either","horizon_minutes":0,"tail_percentile":0.995,"minimum_move_percent":0}'::jsonb), 'invalid move horizon');

insert into public.alert_rules (id, user_id, asset, dex, detector, configuration, delivery)
values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'xyz:ORCL', 'xyz', 'fixed_price', '{"direction":"above","target":100}', 'email'
);

select lives_ok(
  $$select public.record_alert_occurrence(
    '10000000-0000-0000-0000-000000000001', '2026-07-18 12:00:00+00', 101,
    'fixed_price', '{"target":100}'::jsonb
  )$$,
  'records occurrence and outbox atomically'
);
select is((select count(*)::integer from public.alert_occurrences), 1, 'one occurrence');
select is((select count(*)::integer from public.notification_outbox), 1, 'one outbox row');
select is((select enabled from public.alert_rules where id = '10000000-0000-0000-0000-000000000001'), false, 'fixed rule disabled');

update public.alert_rules set enabled = true where id = '10000000-0000-0000-0000-000000000001';
select lives_ok(
  $$select public.record_alert_occurrence(
    '10000000-0000-0000-0000-000000000001', '2026-07-18 12:00:00+00', 101,
    'fixed_price', '{"target":100}'::jsonb
  )$$,
  'replay is idempotent'
);
select is((select count(*)::integer from public.alert_occurrences), 1, 'replay keeps one occurrence');
select is((select count(*)::integer from public.notification_outbox), 1, 'replay keeps one outbox row');

select is((select count(*)::integer from public.claim_outbox(10)), 1, 'claims due outbox row');
select is((select state from public.notification_outbox limit 1), 'claimed', 'outbox state claimed');

insert into public.market_observations (asset, dex, bucket, observed_at, mark_price)
values ('xyz:ORCL', 'xyz', now() - interval '31 days', now() - interval '31 days', 100);
select is((public.prune_listener_history() ->> 'observations')::integer, 1, 'prunes old observations');

select * from finish();
rollback;
