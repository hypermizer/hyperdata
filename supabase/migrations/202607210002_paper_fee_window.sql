create index if not exists paper_fills_epoch_source_timestamp_idx
on public.paper_fills (epoch_id, source_timestamp);

create index if not exists paper_fills_epoch_asset_source_timestamp_idx
on public.paper_fills (epoch_id, asset, source_timestamp);

create or replace function public.paper_fee_volume(
  p_epoch_id uuid,
  p_now timestamptz default now()
)
returns table (trailing_volume numeric, maker_volume numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(sum(abs(f.size * f.price)), 0)::numeric as trailing_volume,
    coalesce(sum(abs(f.size * f.price)) filter (where f.liquidity = 'maker'), 0)::numeric as maker_volume
  from public.paper_fills f
  where f.epoch_id = p_epoch_id
    and f.source_timestamp >= (date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC') - interval '14 days'
    and f.source_timestamp < (date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC')
    and (
      auth.role() = 'service_role'
      or exists (
        select 1
        from public.paper_account_epochs e
        join public.paper_accounts a on a.id = e.account_id
        where e.id = p_epoch_id
          and a.user_id = auth.uid()
          and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'
      )
    );
$$;

revoke all on function public.paper_fee_volume(uuid, timestamptz) from public;
grant execute on function public.paper_fee_volume(uuid, timestamptz) to authenticated, service_role;

create or replace function public.paper_funding_exposure(
  p_epoch_id uuid,
  p_asset text,
  p_timestamps timestamptz[]
)
returns table (funding_timestamp timestamptz, signed_size numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select
    boundary.funding_timestamp,
    coalesce(sum(case f.side when 'buy' then f.size else -f.size end), 0)::numeric as signed_size
  from unnest(p_timestamps) as boundary(funding_timestamp)
  left join public.paper_fills f
    on f.epoch_id = p_epoch_id
    and f.asset = p_asset
    and f.source_timestamp < boundary.funding_timestamp
  where auth.role() = 'service_role'
  group by boundary.funding_timestamp
  order by boundary.funding_timestamp;
$$;

revoke all on function public.paper_funding_exposure(uuid, text, timestamptz[]) from public;
grant execute on function public.paper_funding_exposure(uuid, text, timestamptz[]) to service_role;
