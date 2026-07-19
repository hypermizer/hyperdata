begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000121',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(),
  '{}', '{}', now(), now()
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000121","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select public.create_paper_account('Concurrent account');

reset role;
select lives_ok(
  $$select public.apply_paper_effects(
    (select id from public.paper_accounts where name = 'Concurrent account'), 1, 0, 'command-1',
    '{"response":{"status":"accepted"},"ledger":[{"entry_type":"fee","amount":"-1.250000","asset":"xyz:ORCL"}]}'::jsonb
  )$$,
  'service applies first command atomically'
);
select is((select version from public.paper_account_epochs), 1::bigint, 'command advances epoch version');
select is((select count(*)::integer from public.paper_commands), 1, 'one command recorded');
select is((select count(*)::integer from public.paper_ledger_entries), 2, 'opening and fee ledger entries exist');
select is(
  (public.apply_paper_effects(
    (select id from public.paper_accounts where name = 'Concurrent account'), 1, 0, 'command-1',
    '{"response":{"status":"accepted"}}'::jsonb
  ) -> 'response' ->> 'status'),
  'accepted',
  'duplicate command returns canonical stored response'
);
select is((select count(*)::integer from public.paper_commands), 1, 'duplicate command creates no second command');
select throws_ok(
  $$select public.apply_paper_effects(
    (select id from public.paper_accounts where name = 'Concurrent account'), 1, 0, 'command-2',
    '{"response":{"status":"accepted"},"ledger":[{"entry_type":"fee","amount":"-9.000000"}]}'::jsonb
  )$$,
  '40001', 'stale paper account version', 'stale version rejects entire effect set'
);
select is((select count(*)::integer from public.paper_commands), 1, 'stale command rolls back command row');
select is((select count(*)::integer from public.paper_ledger_entries), 2, 'stale command rolls back ledger row');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000121","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select is(
  public.reset_paper_account((select id from public.paper_accounts where name = 'Concurrent account')),
  2,
  'reset creates the next epoch'
);
select is((select active_epoch from public.paper_accounts), 2, 'account points to new epoch');
select is((select count(*)::integer from public.paper_account_epochs), 2, 'old epoch remains as history');
select is((select count(*)::integer from public.paper_account_epochs where state = 'closed'), 1, 'old epoch is closed');
select is(
  (select cash_balance::text from public.paper_account_summaries s join public.paper_account_epochs e on e.id = s.epoch_id where e.state = 'active'),
  '5000.000000',
  'new epoch starts at exactly 5000 USDC'
);

reset role;
select throws_ok(
  $$select public.apply_paper_effects(
    (select id from public.paper_accounts where name = 'Concurrent account'), 1, 1, 'old-epoch-command',
    '{"response":{"status":"accepted"}}'::jsonb
  )$$,
  'P0001', 'paper account epoch is not active', 'closed epoch rejects future effects'
);

select * from finish();
rollback;
