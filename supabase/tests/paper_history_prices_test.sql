begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000121', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000122', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

insert into public.paper_accounts (id, user_id, name)
values ('00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000121', 'HISTORY TEST');
insert into public.paper_account_epochs (id, account_id, epoch_number, state)
values ('00000000-0000-0000-0000-000000000222', '00000000-0000-0000-0000-000000000221', 1, 'active');

insert into public.paper_fills (
  epoch_id, asset, side, liquidity, size, price, fee,
  source_id, source_timestamp, input_version, fidelity
) values
  ('00000000-0000-0000-0000-000000000222', 'xyz:DRAM', 'sell', 'taker', 2, 100, 0.09, 'history-fill-1', '2026-07-21 10:00:00+00', 'book-1', 'exact_book'),
  ('00000000-0000-0000-0000-000000000222', 'xyz:DRAM', 'sell', 'taker', 1, 130, 0.03, 'history-fill-2', '2026-07-21 10:00:00+00', 'book-1', 'exact_book');

insert into public.paper_orders (
  id, epoch_id, client_order_id, asset, side, order_type, time_in_force,
  margin_mode, leverage, size, remaining_size, reduce_only, status,
  fidelity, source_timestamp
) values
  ('00000000-0000-0000-0000-000000000224', '00000000-0000-0000-0000-000000000222', 'history-order-1', 'xyz:DRAM', 'sell', 'market', null, 'cross', 10, 2, 0, false, 'filled', 'exact_book', '2026-07-21 12:00:00+00'),
  ('00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000222', 'history-order-2', 'xyz:DRAM', 'sell', 'market', null, 'cross', 10, 1, 0, false, 'filled', 'exact_book', '2026-07-21 12:00:00+00');
insert into public.paper_fills (
  epoch_id, order_id, asset, side, liquidity, size, price, fee,
  source_id, source_timestamp, input_version, fidelity
) values
  ('00000000-0000-0000-0000-000000000222', '00000000-0000-0000-0000-000000000224', 'xyz:DRAM', 'sell', 'maker', 2, 100, 0.09, 'scheduled-fill-1', '2026-07-21 12:00:00+00', 'book-2', 'exact_book'),
  ('00000000-0000-0000-0000-000000000222', '00000000-0000-0000-0000-000000000225', 'xyz:DRAM', 'sell', 'maker', 1, 130, 0.03, 'scheduled-fill-2', '2026-07-21 12:00:00+00', 'book-2', 'exact_book');

insert into public.paper_funding_payments (
  id, epoch_id, asset, funding_timestamp, signed_size, oracle_price,
  funding_rate, payment, input_version
) values (
  '00000000-0000-0000-0000-000000000223',
  '00000000-0000-0000-0000-000000000222', 'BTC',
  '2026-07-21 11:00:00+00', 1, 95000, 0.0001, -9.5, 'funding-1'
);

insert into public.paper_ledger_entries (
  epoch_id, entry_type, amount, asset, reference_id, source_timestamp, created_at
) values
  ('00000000-0000-0000-0000-000000000222', 'fee', -0.12, 'xyz:DRAM', null, '2026-07-21 10:00:00+00', '2026-07-21 10:00:02+00'),
  ('00000000-0000-0000-0000-000000000222', 'realized_pnl', 2, 'xyz:DRAM', '00000000-0000-0000-0000-000000000224', '2026-07-21 12:00:00+00', '2026-07-21 12:00:02+00'),
  ('00000000-0000-0000-0000-000000000222', 'funding', -9.5, 'BTC', '00000000-0000-0000-0000-000000000223', '2026-07-21 11:00:00+00', '2026-07-21 11:00:03+00'),
  ('00000000-0000-0000-0000-000000000222', 'opening_balance', 5000, null, null, null, '2026-07-21 09:00:00+00');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000121","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.paper_ledger_history), 4, 'owner reads every history row');
select is((select asset_price from public.paper_ledger_history where entry_type = 'fee'), 110::numeric, 'execution history uses size-weighted fill price');
select is((select asset_price from public.paper_ledger_history where entry_type = 'realized_pnl'), 100::numeric, 'referenced order price is not blended with another order at the same timestamp');
select is((select asset_price from public.paper_ledger_history where entry_type = 'funding'), 95000::numeric, 'funding history uses its oracle price');
select is((select asset_price from public.paper_ledger_history where entry_type = 'opening_balance'), null::numeric, 'non-asset history has no price');
select is((select event_at from public.paper_ledger_history where entry_type = 'fee'), '2026-07-21 10:00:00+00'::timestamptz, 'history exposes the source event time');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000122","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.paper_ledger_history), 0, 'another user cannot read owner history');

set local role anon;
select throws_ok($$select count(*) from public.paper_ledger_history$$, '42501', null, 'anonymous users cannot read history');

select * from finish();
rollback;
