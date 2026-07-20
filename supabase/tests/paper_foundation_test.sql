begin;
create extension if not exists pgtap with schema extensions;
select plan(16);
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

select lives_ok($$select public.create_paper_account('Mean Reversion', 12500)$$, 'creates first account with custom capital');
select lives_ok($$select public.create_paper_account('Oil Events')$$, 'creates second account');
select is((select count(*)::integer from public.paper_accounts), 2, 'two independent accounts exist');
select is((select count(*)::integer from public.paper_account_epochs), 2, 'each account has one epoch');
select is((select count(*)::integer from public.paper_account_summaries), 2, 'each account has one summary');
select is((select starting_capital::text from public.paper_accounts where name = 'Mean Reversion'), '12500.000000', 'custom starting capital persists');
select is((select cash_balance::text from public.paper_account_summaries s join public.paper_account_epochs e on e.id = s.epoch_id join public.paper_accounts a on a.id = e.account_id where a.name = 'Mean Reversion'), '12500.000000', 'custom summary starts at selected capital');
select is((select cash_balance::text from public.paper_account_summaries s join public.paper_account_epochs e on e.id = s.epoch_id join public.paper_accounts a on a.id = e.account_id where a.name = 'Oil Events'), '5000.000000', 'default starting capital remains 5000');
select is(
  (select count(*)::integer from public.paper_ledger_entries where entry_type = 'opening_balance'),
  2,
  'each account has one opening ledger entry'
);
select is(
  (select sum(amount)::text from public.paper_ledger_entries where entry_type = 'opening_balance'),
  '17500.000000',
  'opening ledgers remain independent and reconcile'
);
select is(public.reset_paper_account((select id from public.paper_accounts where name = 'Mean Reversion')), 2, 'custom-capital account resets');
select is((select cash_balance::text from public.paper_account_summaries s join public.paper_account_epochs e on e.id = s.epoch_id where e.account_id = (select id from public.paper_accounts where name = 'Mean Reversion') and e.state = 'active'), '12500.000000', 'reset restores selected starting capital');
select throws_ok(
  $$select public.create_paper_account(' mean reversion ')$$,
  '23505', null, 'active account names are unique case-insensitively'
);
select is((select count(*)::integer from public.paper_accounts), 2, 'failed duplicate creates no account');
select is((select count(*)::integer from public.paper_ledger_entries), 3, 'failed duplicate creates no ledger effect beyond reset');
select is((select count(*)::integer from public.paper_orders), 0, 'new accounts have no orders');

select * from finish();
rollback;
