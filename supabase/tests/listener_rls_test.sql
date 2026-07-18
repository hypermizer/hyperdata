begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

insert into public.alert_rules (user_id, asset, detector, configuration)
values ('00000000-0000-0000-0000-000000000011', 'xyz:ORCL', 'fixed_price', '{"direction":"above","target":100}');

set local role anon;
select is((select count(*)::integer from public.alert_rules), 0, 'anonymous cannot read alert rules');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000011","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.alert_rules), 1, 'allowed owner can read alert rules');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000012","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.alert_rules), 0, 'different user cannot read owner rules');
select throws_ok(
  $$insert into public.alert_rules (user_id, asset, detector, configuration) values (
    '00000000-0000-0000-0000-000000000012', 'BTC', 'fixed_price', '{"direction":"above","target":100}'
  )$$,
  '42501', null, 'disallowed email cannot insert alert rules'
);

select * from finish();
rollback;
