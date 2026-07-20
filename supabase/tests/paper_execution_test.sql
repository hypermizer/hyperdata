begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000131',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(),
  '{}', '{}', now(), now()
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000131","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select public.create_paper_account('Execution account');

reset role;
select lives_ok(
  $$select public.apply_paper_effects(
    (select id from public.paper_accounts where name = 'Execution account'), 1, 0, 'market-buy-1',
    '{
      "response":{"status":"filled","remainingSize":"0","reason":null,"fidelity":"exact_book","sourceTimestamp":"2026-07-19T12:00:00Z"},
      "order":{"asset":"xyz:ORCL","side":"buy","size":"0.75","orderType":"market","timeInForce":null,"limitPrice":null,"leverage":5,"marginMode":"isolated","reduceOnly":false,"requestedSize":"0.75","remainingSize":"0","queueAhead":null,"status":"filled"},
      "fills":[
        {"price":"100","size":"0.5","fee":"0.0225","liquidity":"taker","sourceId":"book-v1:0"},
        {"price":"101","size":"0.25","fee":"0.0113625","liquidity":"taker","sourceId":"book-v1:1"}
      ],
      "position":{"signedSize":"0.75","entryPrice":"100.33333333333333333333"},
      "positionProjection":{"asset":"xyz:ORCL","marginMode":"isolated","signedSize":"0.75","entryPrice":"100.33333333333333333333","markPrice":"101","leverage":5,"inputVersion":"book-v1"},
      "ledger":[{"entry_type":"fee","amount":"-0.0338625","asset":"xyz:ORCL","source_timestamp":"2026-07-19T12:00:00Z"}],
      "inputVersions":{"book":"book-v1","fees":"fees-v1"}
    }'::jsonb
  )$$,
  'applies order, fills, position, ledger, and projection atomically'
);
select is((select count(*)::integer from public.paper_orders), 1, 'one canonical order');
select is((select count(*)::integer from public.paper_fills), 2, 'two visible-depth fills');
select is((select signed_size::text from public.paper_positions), '0.750000000000', 'net position persisted');
select is((select entry_price::numeric(38, 12)::text from public.paper_positions), '100.333333333333', 'weighted entry persisted');
select is((select cash_balance::text from public.paper_account_summaries), '4999.966137', 'fee ledger updates cash');
select is((select cumulative_fees::text from public.paper_account_summaries), '0.033863', 'fee projection reconciles');
select is((select trailing_volume::text from public.paper_account_summaries), '75.250000', 'notional volume accumulates');
select is((select version from public.paper_account_epochs), 1::bigint, 'economic transaction advances version');
select is((select equity::text from public.paper_account_summaries), '5000.466137', 'initial fill stores reconciled equity');
select is((select leverage from public.paper_leverage_settings), 5, 'validated leverage persists for scheduled fills');

select * from finish();
rollback;
