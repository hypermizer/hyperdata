begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000072', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

set local role anon;
select throws_ok($$select count(*) from public.trade_csv_uploads$$, '42501', null, 'anonymous cannot read trade CSV uploads');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000071","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select lives_ok($$insert into public.trade_csv_uploads (user_id, file_name, file_size, content_sha256, content) values ('00000000-0000-0000-0000-000000000071', 'fills.csv', 8, repeat('a', 64), 'a,b' || chr(10) || '1,2' || chr(10))$$, 'allowed owner can stage a trade CSV');
select is((select count(*)::integer from public.trade_csv_uploads), 1, 'owner can read their staged CSV');
select lives_ok($$insert into public.trade_csv_uploads (user_id, file_name, file_size, content_sha256, content) values ('00000000-0000-0000-0000-000000000071', 'new.csv', 8, repeat('b', 64), 'a,b' || chr(10) || '3,4' || chr(10)) on conflict (user_id) do update set file_name = excluded.file_name, file_size = excluded.file_size, content_sha256 = excluded.content_sha256, content = excluded.content, uploaded_at = now()$$, 'the latest full CSV replaces the previous upload');
select is((select file_name from public.trade_csv_uploads), 'new.csv', 'replacement metadata is retained');
select is((select count(*)::integer from public.trade_csv_uploads), 1, 'only one full CSV is stored per user');
select throws_ok($$update public.trade_csv_uploads set content_sha256 = 'bad'$$, '23514', null, 'hash must be lowercase SHA-256 hex');
select throws_ok($$update public.trade_csv_uploads set content = ''$$, '23514', null, 'CSV content cannot be empty');
select throws_ok($$update public.trade_csv_uploads set file_size = file_size + 1$$, '23514', null, 'declared file size must match stored UTF-8 bytes');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000072","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.trade_csv_uploads), 0, 'different user cannot read the owner upload');
select throws_ok($$insert into public.trade_csv_uploads (user_id, file_name, file_size, content_sha256, content) values ('00000000-0000-0000-0000-000000000072', 'fills.csv', 4, repeat('c', 64), 'a,b' || chr(10))$$, '42501', null, 'disallowed email cannot upload');
select lives_ok($$delete from public.trade_csv_uploads where user_id = '00000000-0000-0000-0000-000000000071'$$, 'a delete cannot target an upload hidden by RLS');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000071","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.trade_csv_uploads), 1, 'the owner upload remains after the other user delete attempt');

select * from finish();
rollback;
