begin;
create extension if not exists pgtap with schema extensions;
select plan(23);
select public.configure_paper_mutation_access(true);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000151',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(),
  '{}', '{}', now(), now()
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000151","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select public.create_paper_account('Replay account');
reset role;

select lives_ok(
  $$select public.apply_paper_effects(
    (select id from public.paper_accounts where name = 'Replay account'), 1, 0, 'resting-buy-1',
    '{
      "response":{"status":"resting","remainingSize":"2","reason":null,"fidelity":"estimated_queue","sourceTimestamp":"2026-07-19T12:00:00Z"},
      "order":{"asset":"xyz:ORCL","side":"buy","orderType":"limit","timeInForce":"GTC","limitPrice":"100","leverage":5,"marginMode":"cross","reduceOnly":false,"requestedSize":"2","remainingSize":"2","queueAhead":"1","status":"resting"},
      "fills":[],"position":null,"positionProjection":null,"ledger":[],
      "inputVersions":{"book":"book-v1","fees":"fees-v1"}
    }'::jsonb
  )$$,
  'creates the resting order'
);

set local role service_role;
select ok(public.apply_paper_replay_effect(
  (select id from public.paper_account_epochs limit 1), 1,
  jsonb_build_object(
    'orderId', (select id from public.paper_orders limit 1),
    'status', 'partially_filled', 'remainingSize', '0.5', 'queueAhead', '0',
    'fills', '[{"price":"100","size":"1.5","fee":"-0.0015","liquidity":"maker","sourceId":"trades-v1:o1:0"}]'::jsonb,
    'position', '{"signedSize":"1.5","entryPrice":"100"}'::jsonb,
    'realizedPnl', '0', 'fee', '-0.0015', 'markPrice', '100',
    'inputVersion', 'trades-v1', 'sourceTimestamp', '2026-07-19T12:00:10Z'
  )
), 'replay effect applies');
select is((select status from public.paper_orders), 'partially_filled', 'order status advances');
select is((select remaining_size::text from public.paper_orders), '0.500000000000', 'remaining size advances');
select is((select count(*)::integer from public.paper_fills), 1, 'one maker fill persists');
select is((select signed_size::text from public.paper_positions), '1.500000000000', 'position persists');
select is((select cash_balance::text from public.paper_account_summaries), '5000.001500', 'maker rebate credits cash');
select is((select equity::text from public.paper_account_summaries), '5000.001500', 'summary reconciles after fill');
select is((select version from public.paper_account_epochs), 2::bigint, 'replay advances account version');
select isnt(public.apply_paper_replay_effect(
  (select id from public.paper_account_epochs limit 1), 1,
  jsonb_build_object('orderId', (select id from public.paper_orders limit 1))
), true, 'stale retry cannot duplicate the effect');

select ok(public.apply_paper_funding_effect(
  (select id from public.paper_account_epochs limit 1), 2, 'xyz:ORCL',
  '{"fundingTimestamp":"2026-07-19T13:00:00Z","signedSize":"1.5","oraclePrice":"100","fundingRate":"0.0001","payment":"-0.015","inputVersion":"funding-v1"}'::jsonb
), 'funding effect applies');
select is((select count(*)::integer from public.paper_funding_payments), 1, 'funding row persists once');
select is((select cash_balance::text from public.paper_account_summaries), '4999.986500', 'positive funding debits the long');
select is((select cumulative_funding::text from public.paper_positions), '-0.015000', 'position funding accumulates');
select ok(public.apply_paper_funding_effect(
  (select id from public.paper_account_epochs limit 1), 3, 'xyz:ORCL',
  '{"fundingTimestamp":"2026-07-19T13:00:00Z","signedSize":"1.5","oraclePrice":"100","fundingRate":"0.0001","payment":"-0.015","inputVersion":"funding-v1"}'::jsonb
), 'duplicate funding is an exactly-once no-op');

select ok(public.apply_paper_liquidation_effect(
  (select id from public.paper_account_epochs limit 1), 3,
  jsonb_build_object(
    'asset', 'xyz:ORCL', 'classification', 'book',
    'maintenanceMargin', '100', 'remainingEquity', '4984.8515',
    'cooldownUntil', null, 'sourceTimestamp', '2026-07-19T13:00:10Z',
    'inputVersion', 'liq-v1',
    'fills', '[{"price":"90","size":"1.5","fee":"0.135","liquidity":"liquidation","sourceId":"liq-v1:liquidation:0"}]'::jsonb,
    'position', 'null'::jsonb, 'realizedPnl', '-15', 'totalFee', '0.135',
    'triggerSnapshot', '{"equity":"50","maintenanceMargin":"100","markPrice":"90","positionNotional":"135","signedSize":"1.5"}'::jsonb
  )
), 'liquidation applies atomically');
select is((select status from public.paper_orders), 'canceled', 'open orders cancel before liquidation');
select is((select rejection_reason from public.paper_orders), 'liquidation', 'cancellation reason is preserved');
select is((select count(*)::integer from public.paper_liquidations), 1, 'liquidation event persists');
select is((select count(*)::integer from public.paper_fills), 2, 'liquidation fill persists');
select is((select count(*)::integer from public.paper_positions), 0, 'closed position is removed');
select is((select cash_balance::text from public.paper_account_summaries), '4984.851500', 'liquidation pnl and fee reconcile cash');
select is((select version from public.paper_account_epochs), 4::bigint, 'liquidation advances account version');

select * from finish();
rollback;
