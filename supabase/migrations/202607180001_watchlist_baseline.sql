create table if not exists public.watchlist_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  asset text not null check (char_length(asset) > 0),
  created_at timestamptz not null default now(),
  primary key (user_id, asset)
);

alter table public.watchlist_items enable row level security;

drop policy if exists "Users manage their own watchlist" on public.watchlist_items;
create policy "Users manage their own watchlist"
on public.watchlist_items
for all
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'
)
with check (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'
);
