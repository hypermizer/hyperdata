begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000141', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()
);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000141","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select public.create_paper_account('Controls account');
select ok(public.set_paper_leverage((select id from public.paper_accounts), 'xyz:ORCL', 'isolated', 5, 1000), 'sets leverage');
select is((select leverage from public.paper_leverage_settings), 5, 'leverage projection persists');
select is((select margin_mode from public.paper_leverage_settings), 'isolated', 'margin mode persists');
select throws_ok(
  $$select public.set_paper_leverage((select id from public.paper_accounts), 'xyz:ORCL', 'cross', 0, null)$$,
  'P0001', 'invalid leverage setting', 'invalid leverage rejects'
);

reset role;
insert into public.paper_orders (
  epoch_id, client_order_id, asset, side, order_type, time_in_force, margin_mode,
  leverage, size, remaining_size, limit_price, status, fidelity
) select id, 'resting-1', 'xyz:ORCL', 'buy', 'limit', 'GTC', 'isolated', 5, 1, 1, 90, 'resting', 'estimated_queue'
from public.paper_account_epochs;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000141","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select ok(public.cancel_paper_order((select id from public.paper_accounts), (select id from public.paper_orders)), 'owner cancels active order');
select is((select status from public.paper_orders), 'canceled', 'order is canceled');
select is((select reserved_margin::text from public.paper_orders), '0.000000', 'cancellation releases reserved margin');

select * from finish();
rollback;
