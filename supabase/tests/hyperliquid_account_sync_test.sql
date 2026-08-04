begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000081', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000082', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

insert into public.hyperliquid_account_sources (user_id, address, active)
values
  ('00000000-0000-0000-0000-000000000081', '0x003b9e3e0cfd28ba45a3723e393c5443c92792ac', true),
  ('00000000-0000-0000-0000-000000000082', '0x1111111111111111111111111111111111111111', false);

set local role anon;
select throws_ok($$select count(*) from public.hyperliquid_account_sources$$, '42501', null, 'anonymous cannot read account sources');
select throws_ok($$select count(*) from public.hyperliquid_account_fills$$, '42501', null, 'anonymous cannot read account fills');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000081","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.hyperliquid_account_sources), 1, 'owner can read their source');
select throws_ok($$update public.hyperliquid_account_sources set address = '0x1111111111111111111111111111111111111111'$$, '42501', null, 'client cannot mutate source configuration');

set local role service_role;
insert into public.hyperliquid_account_fills
  (user_id, account_address, trade_id, occurred_at, occurred_at_ms, asset, side, direction, price, size, closed_pnl, fee, fee_token, order_id, transaction_hash, raw)
values
  ('00000000-0000-0000-0000-000000000081', '0x003b9e3e0cfd28ba45a3723e393c5443c92792ac', '123', to_timestamp(1000), 1000000, 'xyz:DRAM', 'sell', 'Close Long', 51.5, 2, 3, 0.01, 'USDC', '456', '0xabc', '{}'),
  ('00000000-0000-0000-0000-000000000082', '0x1111111111111111111111111111111111111111', '999', to_timestamp(1001), 1001000, 'BTC', 'buy', 'Open Long', 100000, 1, 0, 0.1, 'USDC', '777', '0xdef', '{}');
select throws_ok($$insert into public.hyperliquid_account_fills (user_id, account_address, trade_id, occurred_at, occurred_at_ms, asset, side, direction, price, size, order_id, raw) values ('00000000-0000-0000-0000-000000000081', '0x003b9e3e0cfd28ba45a3723e393c5443c92792ac', '123', now(), 1000000, 'xyz:DRAM', 'sell', 'Close Long', 51.5, 2, '456', '{}')$$, '23505', null, 'trade id is idempotent per account');

insert into public.hyperliquid_account_positions
  (user_id, account_address, dex, asset, signed_size, entry_price, position_value, unrealized_pnl, margin_used, liquidation_price, leverage_type, leverage, raw, observed_at)
values ('00000000-0000-0000-0000-000000000081', '0x003b9e3e0cfd28ba45a3723e393c5443c92792ac', 'xyz', 'xyz:DRAM', -2, 51.5, 103, 2, 4, 70, 'cross', 25, '{}', now());

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000081","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.hyperliquid_account_fills), 1, 'owner reads only their fills');
select is((select asset from public.hyperliquid_account_positions), 'xyz:DRAM', 'owner reads current positions');
select throws_ok($$delete from public.hyperliquid_account_fills$$, '42501', null, 'client cannot delete authoritative fills');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000082","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.hyperliquid_account_fills), 0, 'other user cannot read fills');
select is((select count(*)::integer from public.hyperliquid_account_positions), 0, 'other user cannot read positions');

set local role service_role;
select is((select user_id from public.claim_hyperliquid_account_source(90)), '00000000-0000-0000-0000-000000000081'::uuid, 'scheduler claims an eligible source');
select is((select count(*)::integer from public.claim_hyperliquid_account_source(90)), 0, 'active lease prevents overlap');
select lives_ok($$select public.finish_hyperliquid_account_sync('00000000-0000-0000-0000-000000000081', true, 1000000, 900000, 800000, null)$$, 'successful sync advances cursors and releases lease');
select is((select fills_cursor_ms from public.hyperliquid_account_sources where user_id = '00000000-0000-0000-0000-000000000081'), 1000000::bigint, 'fill cursor advances');
select ok((select last_success_at is not null and lease_until is null from public.hyperliquid_account_sources where user_id = '00000000-0000-0000-0000-000000000081'), 'success health is recorded');

select function_privs_are('public', 'claim_hyperliquid_account_source', array['integer'], 'authenticated', array[]::text[], 'client cannot claim sync work');
select function_privs_are('public', 'finish_hyperliquid_account_sync', array['uuid','boolean','bigint','bigint','bigint','text'], 'authenticated', array[]::text[], 'client cannot finish sync work');
select function_privs_are('public', 'configure_hyperliquid_account_cron', array[]::text[], 'service_role', array['EXECUTE'], 'service configures account cron');

select * from finish();
rollback;
