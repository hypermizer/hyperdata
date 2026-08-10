alter table public.asset_analytics_cache
add column if not exists daily_volume_history jsonb not null default '[]'::jsonb
check (jsonb_typeof(daily_volume_history) = 'array');

create or replace function public.record_asset_price_samples(
  p_bucket timestamptz,
  p_samples jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  sample record;
  bucket_ms bigint;
  retention_ms bigint;
  recent_ms bigint;
  day_ms bigint;
  updated_count integer := 0;
  affected_count integer := 0;
begin
  if p_bucket is null or p_samples is null or jsonb_typeof(p_samples) <> 'array' or jsonb_array_length(p_samples) > 1000 then
    raise exception 'Invalid asset price snapshot' using errcode = '22023';
  end if;

  bucket_ms := floor(extract(epoch from p_bucket) * 1000)::bigint;
  retention_ms := bucket_ms - (31::bigint * 24 * 60 * 60 * 1000);
  recent_ms := bucket_ms - (25::bigint * 60 * 60 * 1000);
  day_ms := floor(bucket_ms::numeric / 86400000)::bigint * 86400000;

  for sample in
    select
      value->>'asset' as asset,
      (value->>'price')::numeric as price,
      case
        when value->>'dayVolume' ~ '^[0-9]+(?:\.[0-9]+)?$' then (value->>'dayVolume')::numeric
        else null
      end as day_volume
    from jsonb_array_elements(p_samples)
    where jsonb_typeof(value) = 'object'
      and value->>'asset' ~ '^[a-zA-Z0-9_.:-]+$'
      and value->>'price' ~ '^[0-9]+(?:\.[0-9]+)?$'
      and (value->>'price')::numeric > 0
  loop
    insert into public.asset_analytics_cache as cache (
      asset,
      average_daily_volume,
      price_history,
      history_updated_at,
      daily_volume_history,
      average_volume_updated_at
    ) values (
      sample.asset,
      sample.day_volume,
      jsonb_build_array(jsonb_build_object('time', bucket_ms, 'price', sample.price)),
      p_bucket,
      case when sample.day_volume is null then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object('time', day_ms, 'volume', sample.day_volume)) end,
      case when sample.day_volume is null then null else p_bucket end
    )
    on conflict (asset) do update
    set price_history = (
      select coalesce(
        jsonb_agg(jsonb_build_object('time', retained.time_ms, 'price', retained.price) order by retained.time_ms),
        '[]'::jsonb
      )
      from (
        select distinct on (
          case when history.time_ms < recent_ms then floor(history.time_ms::numeric / 3600000) else history.time_ms end
        ) history.time_ms, history.price
        from (
          select
            (point->>'time')::bigint as time_ms,
            (point->>'price')::numeric as price,
            0 as source_priority
          from jsonb_array_elements(cache.price_history) point
          where jsonb_typeof(point) = 'object'
            and point->>'time' ~ '^[0-9]+$'
            and point->>'price' ~ '^[0-9]+(?:\.[0-9]+)?$'
          union all
          select bucket_ms, sample.price, 1
        ) history
        where history.time_ms between retention_ms and bucket_ms
          and history.price > 0
        order by
          case when history.time_ms < recent_ms then floor(history.time_ms::numeric / 3600000) else history.time_ms end,
          history.time_ms desc,
          history.source_priority desc
      ) retained
    ),
    history_updated_at = p_bucket,
    daily_volume_history = case when sample.day_volume is null then cache.daily_volume_history else (
      select coalesce(
        jsonb_agg(jsonb_build_object('time', volumes.time_ms, 'volume', volumes.volume) order by volumes.time_ms),
        '[]'::jsonb
      )
      from (
        select distinct on (history.time_ms) history.time_ms, history.volume
        from (
          select (point->>'time')::bigint as time_ms, (point->>'volume')::numeric as volume, 0 as source_priority
          from jsonb_array_elements(cache.daily_volume_history) point
          where jsonb_typeof(point) = 'object'
            and point->>'time' ~ '^[0-9]+$'
            and point->>'volume' ~ '^[0-9]+(?:\.[0-9]+)?$'
          union all
          select day_ms, sample.day_volume, 1
        ) history
        where history.time_ms between day_ms - (29::bigint * 86400000) and day_ms
          and history.volume >= 0
        order by history.time_ms, history.source_priority desc
      ) volumes
    ) end,
    average_daily_volume = case
      when sample.day_volume is null then cache.average_daily_volume
      when cache.average_daily_volume is not null and jsonb_array_length(cache.daily_volume_history) < 6
        then cache.average_daily_volume
      else (
        select avg(volumes.volume)::double precision
        from (
          select distinct on (history.time_ms) history.time_ms, history.volume
          from (
            select (point->>'time')::bigint as time_ms, (point->>'volume')::numeric as volume, 0 as source_priority
            from jsonb_array_elements(cache.daily_volume_history) point
            where jsonb_typeof(point) = 'object'
              and point->>'time' ~ '^[0-9]+$'
              and point->>'volume' ~ '^[0-9]+(?:\.[0-9]+)?$'
            union all
            select day_ms, sample.day_volume, 1
          ) history
          where history.time_ms between day_ms - (29::bigint * 86400000) and day_ms
            and history.volume >= 0
          order by history.time_ms, history.source_priority desc
        ) volumes
      )
    end,
    average_volume_updated_at = case when sample.day_volume is null then cache.average_volume_updated_at else p_bucket end
    where cache.history_updated_at is null or cache.history_updated_at <= excluded.history_updated_at;
    get diagnostics affected_count = row_count;
    updated_count := updated_count + affected_count;
  end loop;

  return updated_count;
end;
$$;

revoke all on function public.record_asset_price_samples(timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.record_asset_price_samples(timestamptz, jsonb) to service_role;
