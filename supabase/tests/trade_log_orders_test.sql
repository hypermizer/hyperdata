begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000062', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.com', '', now(), '{}', '{}', now(), now());

set local role anon;
select throws_ok($$select count(*) from public.trade_log_orders$$, '42501', null, 'anonymous cannot read trade orders');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000061","email":"jasonblick@zohomail.com","role":"authenticated"}', true);
select lives_ok($$insert into public.trade_log_orders (user_id, asset, side, shares, price, executed_at, note) values ('00000000-0000-0000-0000-000000000061', 'xyz:DRAM', 'buy', 100.5, 51.25, '2026-08-04T12:30:00Z', 'initial lot')$$, 'allowed owner can add a trade order');
select is((select count(*)::integer from public.trade_log_orders), 1, 'allowed owner can read their trade orders');
select throws_ok($$insert into public.trade_log_orders (user_id, asset, side, shares, price, executed_at) values ('00000000-0000-0000-0000-000000000061', 'BTC', 'hold', 1, 100000, now())$$, '23514', null, 'side must be buy or sell');
select throws_ok($$insert into public.trade_log_orders (user_id, asset, side, shares, price, executed_at) values ('00000000-0000-0000-0000-000000000061', 'BTC', 'buy', 0, 100000, now())$$, '23514', null, 'shares must be positive');
select throws_ok($$insert into public.trade_log_orders (user_id, asset, side, shares, price, executed_at) values ('00000000-0000-0000-0000-000000000061', 'BTC', 'buy', 1, 0, now())$$, '23514', null, 'price must be positive');
select lives_ok($$insert into public.trade_log_orders (user_id, asset, side, shares, price, executed_at) values ('00000000-0000-0000-0000-000000000061', 'xyz:DRAM', 'sell', 50, 52, '2026-08-04T13:30:00Z')$$, 'partial exits are accepted while shares remain');
select throws_ok($$insert into public.trade_log_orders (user_id, asset, side, shares, price, executed_at) values ('00000000-0000-0000-0000-000000000061', 'xyz:DRAM', 'sell', 51, 53, '2026-08-04T14:30:00Z')$$, 'P0001', null, 'a sell cannot make the chronological share balance negative');
select throws_ok($$delete from public.trade_log_orders where side = 'buy' and asset = 'xyz:DRAM'$$, 'P0001', null, 'an earlier buy cannot be removed when that would orphan a later sell');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000062","email":"other@example.com","role":"authenticated"}', true);
select is((select count(*)::integer from public.trade_log_orders), 0, 'different user cannot read owner trade orders');
select throws_ok($$insert into public.trade_log_orders (user_id, asset, side, shares, price, executed_at) values ('00000000-0000-0000-0000-000000000062', 'BTC', 'buy', 1, 100000, now())$$, '42501', null, 'disallowed email cannot add trade orders');

select * from finish();
rollback;
