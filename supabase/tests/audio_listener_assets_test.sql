begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

set local role anon;
select throws_ok($$select count(*) from public.audio_listener_assets$$, '42501', null, 'anonymous cannot read audio assets');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000021","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select lives_ok($$insert into public.audio_listener_assets (user_id, asset) values ('00000000-0000-0000-0000-000000000021', 'xyz:ORCL')$$, 'allowed owner can remember an audio asset');
select is((select count(*)::integer from public.audio_listener_assets), 1, 'allowed owner can read remembered audio assets');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000022","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.audio_listener_assets), 0, 'different user cannot read owner audio assets');
select throws_ok($$insert into public.audio_listener_assets (user_id, asset) values ('00000000-0000-0000-0000-000000000022', 'BTC')$$, '42501', null, 'disallowed email cannot remember audio assets');

select * from finish();
rollback;
