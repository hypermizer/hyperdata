create table if not exists public.audio_listener_assets (
  user_id uuid not null references auth.users (id) on delete cascade,
  asset text not null check (char_length(asset) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (user_id, asset)
);

alter table public.audio_listener_assets enable row level security;

drop policy if exists "Users manage their own audio assets" on public.audio_listener_assets;
create policy "Users manage their own audio assets"
on public.audio_listener_assets
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

revoke all on table public.audio_listener_assets from anon, authenticated;
grant select, insert, update, delete on table public.audio_listener_assets to authenticated;
grant all privileges on table public.audio_listener_assets to service_role;
