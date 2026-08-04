begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000093', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000094', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

set local role anon;
select throws_ok($$select count(*) from public.level_tool_preferences$$, '42501', null, 'anonymous cannot read preferences');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000093","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select lives_ok($$insert into public.level_tool_preferences (user_id, asset, risk_dollars, session_mode, visible_level_count) values ('00000000-0000-0000-0000-000000000093', 'xyz:DRAM', 750, 'new_york_rth', 15)$$, 'owner can save preferences');
select is((select asset from public.level_tool_preferences), 'xyz:DRAM', 'owner can read preferences');
select throws_ok($$update public.level_tool_preferences set session_mode = 'exchange_guess'$$, '23514', null, 'unsupported session is rejected');
select throws_ok($$update public.level_tool_preferences set visible_level_count = 30$$, '23514', null, 'visible count is bounded');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000094","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.level_tool_preferences), 0, 'different user cannot read owner preferences');
select throws_ok($$insert into public.level_tool_preferences (user_id, asset) values ('00000000-0000-0000-0000-000000000094', 'BTC')$$, '42501', null, 'disallowed user cannot save preferences');

select * from finish();
rollback;
