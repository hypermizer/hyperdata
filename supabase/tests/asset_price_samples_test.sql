begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into public.asset_analytics_cache (asset, price_history, history_updated_at)
values (
  'xyz:DRAM',
  '[{"time":1786003200000,"price":52.623},{"time":1786031999999,"price":52.100}]'::jsonb,
  '2026-08-06T15:28:00Z'
);

set local role service_role;
select is(
  public.record_asset_price_samples(
    '2026-08-06T23:20:00Z',
    '[{"asset":"xyz:DRAM","price":51.472,"dayVolume":75000},{"asset":"xyz:ORCL","price":143.3,"dayVolume":125000}]'::jsonb
  ),
  2,
  'the service role records every valid mark in one snapshot'
);
reset role;

select is(
  (select (price_history->-1->>'time')::bigint from public.asset_analytics_cache where asset = 'xyz:DRAM'),
  1786058400000::bigint,
  'the snapshot stores the canonical five-minute bucket'
);
select is(
  (select (price_history->-1->>'price')::numeric from public.asset_analytics_cache where asset = 'xyz:DRAM'),
  51.472::numeric,
  'the snapshot stores the current mark price'
);
select is(
  (select history_updated_at from public.asset_analytics_cache where asset = 'xyz:DRAM'),
  '2026-08-06T23:20:00Z'::timestamptz,
  'history freshness is updated with the sample bucket'
);
select ok(
  (select first_seen_at is not null from public.asset_analytics_cache where asset = 'xyz:ORCL'),
  'new listings are initialized without a GitHub refresh job'
);
select is(
  (select average_daily_volume from public.asset_analytics_cache where asset = 'xyz:ORCL'),
  125000::double precision,
  'new listings initialize average volume from the live 24-hour notional volume'
);

set local role service_role;
select is(
  public.record_asset_price_samples(
    '2026-08-06T23:21:00Z',
    '[{"asset":"xyz:DRAM","price":51.500,"dayVolume":76000}]'::jsonb
  ),
  1,
  'a newer minute snapshot updates the asset'
);
reset role;

select is(
  (select jsonb_array_length(daily_volume_history) from public.asset_analytics_cache where asset = 'xyz:DRAM'),
  1,
  'same-day rolling volume samples replace the existing UTC-day value'
);
select is(
  (select (daily_volume_history->0->>'volume')::numeric from public.asset_analytics_cache where asset = 'xyz:DRAM'),
  76000::numeric,
  'the daily volume history keeps the newest same-day value'
);

set local role service_role;
select is(
  public.record_asset_price_samples(
    '2026-08-06T23:19:00Z',
    '[{"asset":"xyz:DRAM","price":49.000,"dayVolume":100}]'::jsonb
  ),
  0,
  'a delayed older snapshot cannot overwrite newer analytics'
);
reset role;

select is(
  (select (price_history->-1->>'price')::numeric from public.asset_analytics_cache where asset = 'xyz:DRAM'),
  51.500::numeric,
  'the newest mark remains after an out-of-order snapshot'
);
select is(
  (select history_updated_at from public.asset_analytics_cache where asset = 'xyz:DRAM'),
  '2026-08-06T23:21:00Z'::timestamptz,
  'freshness never moves backward after an out-of-order snapshot'
);

set local role anon;
select throws_ok(
  $$select public.record_asset_price_samples(now(), '[{"asset":"xyz:BAD","price":1}]'::jsonb)$$,
  '42501', null, 'browser clients cannot forge analytics samples'
);

select * from finish();
rollback;
