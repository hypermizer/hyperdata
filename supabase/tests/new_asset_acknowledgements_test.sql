begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

select has_table('public', 'new_asset_acknowledgements', 'new-asset acknowledgements exist');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000095', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000096', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

set local role anon;
select throws_ok($$select count(*) from public.new_asset_acknowledgements$$, '42501', null, 'anonymous cannot read acknowledgements');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000095","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select lives_ok($$insert into public.new_asset_acknowledgements (user_id, asset) values ('00000000-0000-0000-0000-000000000095', 'xyz:NEW')$$, 'owner can acknowledge a new asset');
select is((select asset from public.new_asset_acknowledgements), 'xyz:NEW', 'owner can read acknowledgements');
select lives_ok($$insert into public.new_asset_acknowledgements (user_id, asset) values ('00000000-0000-0000-0000-000000000095', 'xyz:NEW') on conflict (user_id, asset) do update set acknowledged_at = excluded.acknowledged_at$$, 'owner can safely retry an acknowledgement');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000096","email":"other@example.com","role":"authenticated"}', true);
select throws_ok($$insert into public.new_asset_acknowledgements (user_id, asset) values ('00000000-0000-0000-0000-000000000096', 'xyz:OTHER')$$, '42501', null, 'disallowed user cannot acknowledge assets');

select * from finish();
rollback;
