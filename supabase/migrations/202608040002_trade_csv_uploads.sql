create table if not exists public.trade_csv_uploads (
  user_id uuid primary key references auth.users (id) on delete cascade,
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_size bigint not null check (file_size between 1 and 10485760),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  content text not null check (octet_length(content) between 1 and 10485760),
  uploaded_at timestamptz not null default now(),
  check (file_size = octet_length(content))
);

alter table public.trade_csv_uploads enable row level security;

drop policy if exists "Users manage their own trade CSV upload" on public.trade_csv_uploads;
create policy "Users manage their own trade CSV upload"
on public.trade_csv_uploads
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

revoke all on table public.trade_csv_uploads from anon, authenticated;
grant select, insert, update, delete on table public.trade_csv_uploads to authenticated;
grant all privileges on table public.trade_csv_uploads to service_role;
