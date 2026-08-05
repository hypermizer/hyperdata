alter table public.asset_analytics_cache
add column first_seen_at timestamptz;

update public.asset_analytics_cache cache
set first_seen_at = coalesce(
  (
    select to_timestamp(min((point->>'time')::double precision) / 1000.0)
    from jsonb_array_elements(cache.price_history) point
    where jsonb_typeof(point) = 'object'
      and point ? 'time'
      and (point->>'time') ~ '^[0-9]+(?:\.[0-9]+)?$'
  ),
  cache.updated_at - interval '8 days'
);

alter table public.asset_analytics_cache
alter column first_seen_at set default now(),
alter column first_seen_at set not null;
