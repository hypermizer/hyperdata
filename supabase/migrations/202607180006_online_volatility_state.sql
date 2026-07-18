create table public.volatility_states (
  asset text primary key,
  fast_variance double precision not null check (fast_variance > 0 and fast_variance < 'Infinity'::double precision),
  slow_variance double precision not null check (slow_variance > 0 and slow_variance < 'Infinity'::double precision),
  last_mark double precision not null check (last_mark > 0 and last_mark < 'Infinity'::double precision),
  last_bucket timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.volatility_states enable row level security;
