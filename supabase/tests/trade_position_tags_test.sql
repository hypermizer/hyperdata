begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000091', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000092', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());
insert into public.hyperliquid_account_sources (user_id, address)
values ('00000000-0000-0000-0000-000000000091', '0x1111111111111111111111111111111111111111');

set local role anon;
select throws_ok($$select count(*) from public.hyperliquid_account_position_tags$$, '42501', null, 'anonymous cannot read position tags');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000091","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select lives_ok($$insert into public.hyperliquid_account_position_tags (user_id, account_address, position_key, asset, direction, tags) values ('00000000-0000-0000-0000-000000000091', '0x1111111111111111111111111111111111111111', 'xyz:PLTR|short|1', 'xyz:PLTR', 'short', array['EARNINGS','MEANREV'])$$, 'owner can add position tags');
select is((select tags from public.hyperliquid_account_position_tags where position_key = 'xyz:PLTR|short|1'), array['EARNINGS','MEANREV']::text[], 'owner can read saved tags');
select lives_ok($$update public.hyperliquid_account_position_tags set tags = array['YOLO'] where position_key = 'xyz:PLTR|short|1'$$, 'owner can update position tags');
select throws_ok($$update public.hyperliquid_account_position_tags set tags = array['INVALID'] where position_key = 'xyz:PLTR|short|1'$$, '23514', null, 'unsupported tags are rejected');
select throws_ok($$update public.hyperliquid_account_position_tags set direction = 'flat' where position_key = 'xyz:PLTR|short|1'$$, '23514', null, 'direction must be long or short');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000092","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.hyperliquid_account_position_tags), 0, 'different user cannot read owner tags');
select throws_ok($$insert into public.hyperliquid_account_position_tags (user_id, account_address, position_key, asset, direction, tags) values ('00000000-0000-0000-0000-000000000092', '0x2222222222222222222222222222222222222222', 'BTC|long|2', 'BTC', 'long', array['YOLO'])$$, '42501', null, 'disallowed user cannot add position tags');

select * from finish();
rollback;
