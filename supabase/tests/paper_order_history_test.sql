begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000131', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000132', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

insert into public.paper_accounts (id, user_id, name)
values ('00000000-0000-0000-0000-000000000231', '00000000-0000-0000-0000-000000000131', 'ORDER HISTORY TEST');
insert into public.paper_account_epochs (id, account_id, epoch_number, state)
values ('00000000-0000-0000-0000-000000000232', '00000000-0000-0000-0000-000000000231', 1, 'active');
insert into public.paper_orders (
  id, epoch_id, client_order_id, asset, side, order_type, time_in_force,
  margin_mode, leverage, size, remaining_size, reduce_only, status,
  fidelity, source_timestamp
) values (
  '00000000-0000-0000-0000-000000000233', '00000000-0000-0000-0000-000000000232',
  'order-history-1', 'xyz:DRAM', 'sell', 'market', null, 'cross', 10, 3, 0, true,
  'filled', 'exact_book', '2026-07-22 12:00:00+00'
);
insert into public.paper_fills (
  epoch_id, order_id, asset, side, liquidity, size, price, fee,
  source_id, source_timestamp, input_version, fidelity
) values
  ('00000000-0000-0000-0000-000000000232', '00000000-0000-0000-0000-000000000233', 'xyz:DRAM', 'sell', 'taker', 2, 100, 0.09, 'order-history-fill-1', '2026-07-22 12:00:00+00', 'book-1', 'exact_book'),
  ('00000000-0000-0000-0000-000000000232', '00000000-0000-0000-0000-000000000233', 'xyz:DRAM', 'sell', 'taker', 1, 130, 0.03, 'order-history-fill-2', '2026-07-22 12:00:00+00', 'book-1', 'exact_book');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000131","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.paper_order_history), 1, 'owner reads order history');
select is((select filled_size from public.paper_order_history), 3::numeric, 'filled size is aggregated');
select is((select entry_price from public.paper_order_history), 110::numeric, 'entry price is the execution VWAP');
select is((select notional from public.paper_order_history), 330::numeric, 'filled notional is aggregated');
select is((select fees from public.paper_order_history), 0.12::numeric, 'fees are aggregated');
select ok((select reduce_only from public.paper_order_history), 'reduce-only state is retained');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000132","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.paper_order_history), 0, 'another user cannot read owner order history');

set local role anon;
select throws_ok($$select count(*) from public.paper_order_history$$, '42501', null, 'anonymous users cannot read order history');

select * from finish();
rollback;
