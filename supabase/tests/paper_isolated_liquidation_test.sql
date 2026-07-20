begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
select public.configure_paper_mutation_access(true);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000161', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()
);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000161","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select public.create_paper_account('Isolated liquidation account');
reset role;

insert into public.paper_positions (
  epoch_id, asset, margin_mode, signed_size, entry_price, mark_price, isolated_margin, input_version
) values
  ((select id from public.paper_account_epochs), 'xyz:ORCL', 'isolated', 1, 600, 100, 100, 'orcl-v1'),
  ((select id from public.paper_account_epochs), 'BTC', 'cross', 0.1, 50000, 50000, null, 'btc-v1');
insert into public.paper_orders (
  epoch_id, client_order_id, asset, side, order_type, time_in_force, margin_mode,
  leverage, size, remaining_size, limit_price, status, reserved_margin, fidelity
) values
  ((select id from public.paper_account_epochs), 'orcl-order', 'xyz:ORCL', 'buy', 'limit', 'GTC', 'isolated', 5, 1, 1, 90, 'resting', 18, 'estimated_queue'),
  ((select id from public.paper_account_epochs), 'btc-order', 'BTC', 'buy', 'limit', 'GTC', 'cross', 5, 0.1, 0.1, 49000, 'resting', 980, 'estimated_queue');
update public.paper_account_summaries set maintenance_margin = 30
where epoch_id = (select id from public.paper_account_epochs);

select ok(public.apply_paper_liquidation_effect(
  (select id from public.paper_account_epochs), 0,
  '{
    "asset":"xyz:ORCL","classification":"backstop","marginMode":"isolated","isolatedMargin":"100",
    "maintenanceMargin":"20","positionMaintenanceMargin":"20","remainingPositionMaintenanceMargin":"0",
    "remainingEquity":"-400","cooldownUntil":null,"sourceTimestamp":"2026-07-20T12:00:00Z","inputVersion":"liq-isolated-v1",
    "fills":[{"price":"100","size":"1","fee":"0","liquidity":"liquidation","sourceId":"liq-isolated-v1:0"}],
    "position":null,"realizedPnl":"-500","totalFee":"0",
    "triggerSnapshot":{"equity":"-400","maintenanceMargin":"20","markPrice":"100","positionNotional":"100","signedSize":"1"}
  }'::jsonb
), 'isolated liquidation applies');
select is((select cash_balance::text from public.paper_account_summaries), '4900.000000', 'isolated loss is capped to isolated margin');
select is((select sum(amount)::numeric(38, 6)::text from public.paper_ledger_entries where entry_type <> 'opening_balance'), '-100.000000', 'ledger reconciles the capped account loss');
select is((select status from public.paper_orders where client_order_id = 'orcl-order'), 'canceled', 'isolated asset order is canceled');
select is((select status from public.paper_orders where client_order_id = 'btc-order'), 'resting', 'unrelated cross order remains active');
select is((select count(*)::integer from public.paper_positions where asset = 'xyz:ORCL'), 0, 'isolated position closes');
select is((select count(*)::integer from public.paper_positions where asset = 'BTC'), 1, 'unrelated cross position remains');

select * from finish();
rollback;
