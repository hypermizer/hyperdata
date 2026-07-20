begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
select public.configure_paper_mutation_access(true);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(),
  '{}', '{}', now(), now()
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000101","email":"jasonblick@zohomail.com","role":"authenticated"}',
  true
);

select lives_ok($$select public.create_paper_account('Mean Reversion')$$, 'creates first account');
select lives_ok($$select public.create_paper_account('Oil Events')$$, 'creates second account');
select is((select count(*)::integer from public.paper_accounts), 2, 'two independent accounts exist');
select is((select count(*)::integer from public.paper_account_epochs), 2, 'each account has one epoch');
select is((select count(*)::integer from public.paper_account_summaries), 2, 'each account has one summary');
select is(
  (select min(cash_balance)::text from public.paper_account_summaries),
  '5000.000000',
  'each summary starts with exactly 5000 USDC'
);
select is(
  (select count(*)::integer from public.paper_ledger_entries where entry_type = 'opening_balance'),
  2,
  'each account has one opening ledger entry'
);
select is(
  (select sum(amount)::text from public.paper_ledger_entries where entry_type = 'opening_balance'),
  '10000.000000',
  'opening ledgers remain independent and reconcile'
);
select throws_ok(
  $$select public.create_paper_account(' mean reversion ')$$,
  '23505', null, 'active account names are unique case-insensitively'
);
select is((select count(*)::integer from public.paper_accounts), 2, 'failed duplicate creates no account');
select is((select count(*)::integer from public.paper_ledger_entries), 2, 'failed duplicate creates no ledger effect');
select is((select count(*)::integer from public.paper_orders), 0, 'new accounts have no orders');

select * from finish();
rollback;
