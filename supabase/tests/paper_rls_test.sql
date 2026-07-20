begin;
create extension if not exists pgtap with schema extensions;
select plan(8);
select public.configure_paper_mutation_access(true);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000112', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000111","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select lives_ok($$select public.create_paper_account('Owner account')$$, 'allowed owner creates an account');
select is((select count(*)::integer from public.paper_accounts), 1, 'owner reads account');
select is((select count(*)::integer from public.paper_ledger_entries), 1, 'owner reads economic history');
select throws_ok(
  $$insert into public.paper_ledger_entries (epoch_id, entry_type, amount) select id, 'fee', -1 from public.paper_account_epochs limit 1$$,
  '42501', null, 'owner cannot directly write economic history'
);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000112","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.paper_accounts), 0, 'different user reads no accounts');
select is((select count(*)::integer from public.paper_ledger_entries), 0, 'different user reads no ledger');
select throws_ok($$select public.create_paper_account('Wrong email')$$, 'P0001', 'not authorized', 'wrong email cannot create');

set local role anon;
select throws_ok($$select count(*) from public.paper_accounts$$, '42501', null, 'anonymous cannot read paper accounts');

select * from finish();
rollback;
