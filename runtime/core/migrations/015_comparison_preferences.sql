create table public.comparison_preferences (
 user_id uuid primary key references auth.users(id) on delete cascade,
 settings jsonb not null default '{}'::jsonb check(jsonb_typeof(settings)='object' and octet_length(settings::text)<=8192),
 updated_at timestamptz not null default clock_timestamp()
);
alter table public.comparison_preferences enable row level security;
revoke all on public.comparison_preferences from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.comparison_preferences to authenticated;
create policy "Owner manages comparison chart" on public.comparison_preferences to authenticated
 using(auth.uid()=user_id and auth.jwt()->>'email'='jasonblick@zohomail.com')
 with check(auth.uid()=user_id and auth.jwt()->>'email'='jasonblick@zohomail.com');
notify pgrst,'reload schema';
