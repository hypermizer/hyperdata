create table public.asset_analytics_cache (
  asset text primary key check (asset ~ '^[a-zA-Z0-9_.:-]+$'),
  average_daily_volume double precision check (
    average_daily_volume is null
    or (average_daily_volume >= 0 and average_daily_volume < 'Infinity'::double precision)
  ),
  price_history jsonb not null default '[]'::jsonb check (jsonb_typeof(price_history) = 'array'),
  history_updated_at timestamptz,
  average_volume_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create trigger asset_analytics_cache_set_updated_at
before update on public.asset_analytics_cache
for each row execute function public.set_updated_at();

alter table public.asset_analytics_cache enable row level security;

create policy asset_analytics_cache_public_read
on public.asset_analytics_cache for select
to anon, authenticated
using (true);

revoke all on table public.asset_analytics_cache from public, anon, authenticated;
grant select on table public.asset_analytics_cache to anon, authenticated;
grant all on table public.asset_analytics_cache to service_role;
