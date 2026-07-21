begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(),
  '{}', '{}', now(), now()
);

insert into public.paper_accounts (id, user_id, name)
values ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 'FEE TEST');
insert into public.paper_account_epochs (id, account_id, epoch_number, state)
values ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000201', 1, 'active');

insert into public.paper_fills (epoch_id, asset, side, liquidity, size, price, fee, source_id, source_timestamp, input_version, fidelity)
values
  ('00000000-0000-0000-0000-000000000202', 'BTC', 'buy', 'maker', 2, 100, 0, 'included-maker', '2026-07-07 00:00:00+00', 'v1', 'test'),
  ('00000000-0000-0000-0000-000000000202', 'BTC', 'buy', 'taker', 3, 100, 0, 'included-taker', '2026-07-20 23:59:59+00', 'v1', 'test'),
  ('00000000-0000-0000-0000-000000000202', 'BTC', 'buy', 'maker', 5, 100, 0, 'current-day', '2026-07-21 00:00:00+00', 'v1', 'test'),
  ('00000000-0000-0000-0000-000000000202', 'BTC', 'buy', 'maker', 7, 100, 0, 'expired', '2026-07-06 23:59:59+00', 'v1', 'test');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select trailing_volume from public.paper_fee_volume('00000000-0000-0000-0000-000000000202', '2026-07-21 15:00:00+00')), 500::numeric, 'volume includes exactly fourteen completed UTC days');
select is((select maker_volume from public.paper_fee_volume('00000000-0000-0000-0000-000000000202', '2026-07-21 15:00:00+00')), 200::numeric, 'maker volume is aggregated independently');
select is(
  (select signed_size from public.paper_funding_exposure(
    '00000000-0000-0000-0000-000000000202', 'BTC', array['2026-07-07 00:00:00+00'::timestamptz]
  )),
  7::numeric,
  'funding exposure includes only fills strictly before the boundary'
);
select is(
  (select signed_size from public.paper_funding_exposure(
    '00000000-0000-0000-0000-000000000202', 'ETH', array['2026-07-21 00:00:00+00'::timestamptz]
  )),
  0::numeric,
  'funding exposure returns zero for an asset without fills'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000101","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select is((select trailing_volume from public.paper_fee_volume('00000000-0000-0000-0000-000000000202', '2026-07-21 15:00:00+00')), 500::numeric, 'owner can read aggregate');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000999","email":"other@example.com","role":"authenticated"}', true);
select is((select trailing_volume from public.paper_fee_volume('00000000-0000-0000-0000-000000000202', '2026-07-21 15:00:00+00')), 0::numeric, 'non-owner receives no volume');

select * from finish();
rollback;
