create table if not exists public.hyperliquid_account_position_tags (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_address text not null check (account_address ~ '^0x[a-f0-9]{40}$'),
  position_key text not null check (length(position_key) between 1 and 300),
  asset text not null check (length(asset) between 1 and 100),
  direction text not null check (direction in ('long', 'short')),
  tags text[] not null default '{}'
    check (cardinality(tags) <= 3 and tags <@ array['EARNINGS', 'MEANREV', 'YOLO']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, account_address, position_key),
  foreign key (user_id, account_address)
    references public.hyperliquid_account_sources (user_id, address) on delete cascade
);

alter table public.hyperliquid_account_position_tags enable row level security;

drop policy if exists "Owner manages account position tags" on public.hyperliquid_account_position_tags;
create policy "Owner manages account position tags"
on public.hyperliquid_account_position_tags
for all
to authenticated
using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com')
with check (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');

drop trigger if exists hyperliquid_account_position_tags_set_updated_at on public.hyperliquid_account_position_tags;
create trigger hyperliquid_account_position_tags_set_updated_at
before update on public.hyperliquid_account_position_tags
for each row execute function public.set_updated_at();

revoke all on table public.hyperliquid_account_position_tags from anon, authenticated;
grant select, insert, update, delete on table public.hyperliquid_account_position_tags to authenticated;
grant all privileges on table public.hyperliquid_account_position_tags to service_role;
