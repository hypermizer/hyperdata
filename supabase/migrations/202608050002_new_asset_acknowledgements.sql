create table public.new_asset_acknowledgements (
  user_id uuid not null references auth.users (id) on delete cascade,
  asset text not null check (char_length(asset) > 0),
  acknowledged_at timestamptz not null default now(),
  primary key (user_id, asset)
);

alter table public.new_asset_acknowledgements enable row level security;

create policy "Users manage their own new asset acknowledgements"
on public.new_asset_acknowledgements
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

revoke all on table public.new_asset_acknowledgements from anon, authenticated;
grant select, insert, update on table public.new_asset_acknowledgements to authenticated;
grant all privileges on table public.new_asset_acknowledgements to service_role;
