create table if not exists public.level_tool_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  asset text not null check (length(asset) between 1 and 100),
  risk_dollars numeric not null default 500 check (risk_dollars >= 0 and risk_dollars <= 1000000000),
  session_mode text not null default 'auto' check (session_mode in ('auto', 'new_york_rth', 'utc')),
  visible_level_count integer not null default 10 check (visible_level_count between 5 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.level_tool_preferences enable row level security;

drop policy if exists "Owner manages level tool preferences" on public.level_tool_preferences;
create policy "Owner manages level tool preferences"
on public.level_tool_preferences
for all
to authenticated
using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com')
with check (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');

drop trigger if exists level_tool_preferences_set_updated_at on public.level_tool_preferences;
create trigger level_tool_preferences_set_updated_at
before update on public.level_tool_preferences
for each row execute function public.set_updated_at();

revoke all on table public.level_tool_preferences from anon, authenticated;
grant select, insert, update, delete on table public.level_tool_preferences to authenticated;
grant all privileges on table public.level_tool_preferences to service_role;
