create table if not exists public.hyperliquid_account_sources (
  user_id uuid primary key references auth.users (id) on delete cascade,
  address text not null unique check (address ~ '^0x[a-f0-9]{40}$'),
  active boolean not null default true,
  fills_cursor_ms bigint,
  funding_cursor_ms bigint,
  ledger_cursor_ms bigint,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, address)
);

create table if not exists public.hyperliquid_account_fills (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_address text not null check (account_address ~ '^0x[a-f0-9]{40}$'),
  trade_id text not null,
  occurred_at timestamptz not null,
  occurred_at_ms bigint not null check (occurred_at_ms >= 0),
  asset text not null,
  side text not null check (side in ('buy', 'sell')),
  direction text not null,
  price numeric(38, 12) not null check (price > 0),
  size numeric(38, 12) not null check (size > 0),
  start_position numeric(38, 12),
  closed_pnl numeric(38, 12) not null default 0,
  fee numeric(38, 12) not null default 0,
  fee_token text,
  crossed boolean,
  order_id text not null,
  transaction_hash text,
  twap_id text,
  raw jsonb not null,
  ingested_at timestamptz not null default now(),
  primary key (account_address, trade_id),
  foreign key (user_id, account_address) references public.hyperliquid_account_sources (user_id, address) on delete cascade
);
create index if not exists hyperliquid_account_fills_user_time_idx
on public.hyperliquid_account_fills (user_id, occurred_at desc, trade_id);

create table if not exists public.hyperliquid_account_funding (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_address text not null,
  event_key text not null,
  occurred_at timestamptz not null,
  occurred_at_ms bigint not null check (occurred_at_ms >= 0),
  asset text not null,
  funding_rate numeric(38, 18),
  position_size numeric(38, 12),
  usdc numeric(38, 12),
  transaction_hash text,
  raw jsonb not null,
  ingested_at timestamptz not null default now(),
  primary key (account_address, event_key),
  foreign key (user_id, account_address) references public.hyperliquid_account_sources (user_id, address) on delete cascade
);
create index if not exists hyperliquid_account_funding_user_time_idx
on public.hyperliquid_account_funding (user_id, occurred_at desc);

create table if not exists public.hyperliquid_account_ledger (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_address text not null,
  event_key text not null,
  occurred_at timestamptz not null,
  occurred_at_ms bigint not null check (occurred_at_ms >= 0),
  event_type text not null,
  transaction_hash text,
  raw jsonb not null,
  ingested_at timestamptz not null default now(),
  primary key (account_address, event_key),
  foreign key (user_id, account_address) references public.hyperliquid_account_sources (user_id, address) on delete cascade
);
create index if not exists hyperliquid_account_ledger_user_time_idx
on public.hyperliquid_account_ledger (user_id, occurred_at desc);

create table if not exists public.hyperliquid_account_positions (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_address text not null,
  dex text not null,
  asset text not null,
  signed_size numeric(38, 12) not null,
  entry_price numeric(38, 12),
  position_value numeric(38, 12),
  unrealized_pnl numeric(38, 12),
  margin_used numeric(38, 12),
  liquidation_price numeric(38, 12),
  leverage_type text,
  leverage integer,
  raw jsonb not null,
  observed_at timestamptz not null,
  primary key (account_address, dex, asset),
  foreign key (user_id, account_address) references public.hyperliquid_account_sources (user_id, address) on delete cascade
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'hyperliquid_account_sources', 'hyperliquid_account_fills', 'hyperliquid_account_funding',
    'hyperliquid_account_ledger', 'hyperliquid_account_positions'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists "Owner reads %s" on public.%I', table_name, table_name);
    execute format(
      'create policy "Owner reads %s" on public.%I for select to authenticated using (auth.uid() = user_id and auth.jwt() ->> ''email'' = ''jasonblick@zohomail.com'')',
      table_name, table_name
    );
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select on table public.%I to authenticated', table_name);
    execute format('grant all privileges on table public.%I to service_role', table_name);
  end loop;
end;
$$;

create or replace function public.claim_hyperliquid_account_source(p_lease_seconds integer default 90)
returns table (
  user_id uuid, address text, fills_cursor_ms bigint, funding_cursor_ms bigint, ledger_cursor_ms bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease seconds must be between 30 and 300';
  end if;
  return query
  with candidate as (
    select source.user_id
    from public.hyperliquid_account_sources source
    where source.active and (source.lease_until is null or source.lease_until < now())
    order by source.last_attempt_at nulls first
    for update skip locked
    limit 1
  ), claimed as (
    update public.hyperliquid_account_sources source
    set lease_until = now() + make_interval(secs => p_lease_seconds),
        last_attempt_at = now(), updated_at = now()
    from candidate
    where source.user_id = candidate.user_id
    returning source.user_id, source.address, source.fills_cursor_ms, source.funding_cursor_ms, source.ledger_cursor_ms
  )
  select * from claimed;
end;
$$;

create or replace function public.finish_hyperliquid_account_sync(
  p_user_id uuid,
  p_succeeded boolean,
  p_fills_cursor_ms bigint default null,
  p_funding_cursor_ms bigint default null,
  p_ledger_cursor_ms bigint default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.hyperliquid_account_sources
  set fills_cursor_ms = case when p_succeeded and p_fills_cursor_ms is not null then greatest(coalesce(fills_cursor_ms, 0), p_fills_cursor_ms) else fills_cursor_ms end,
      funding_cursor_ms = case when p_succeeded and p_funding_cursor_ms is not null then greatest(coalesce(funding_cursor_ms, 0), p_funding_cursor_ms) else funding_cursor_ms end,
      ledger_cursor_ms = case when p_succeeded and p_ledger_cursor_ms is not null then greatest(coalesce(ledger_cursor_ms, 0), p_ledger_cursor_ms) else ledger_cursor_ms end,
      last_success_at = case when p_succeeded then now() else last_success_at end,
      last_error = case when p_succeeded then null else left(coalesce(p_error, 'unknown sync error'), 1000) end,
      lease_until = null,
      updated_at = now()
  where user_id = p_user_id;
end;
$$;

create or replace function public.configure_hyperliquid_account_cron()
returns void
language plpgsql
security definer
set search_path = public, cron, vault
as $$
declare project_url text; service_key text; monitor_secret text;
begin
  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into monitor_secret from vault.decrypted_secrets where name = 'monitor_secret';
  if project_url is null or service_key is null or monitor_secret is null then
    raise exception 'Vault secrets project_url, service_role_key, and monitor_secret are required';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'hyperdata-sync-account';
  perform cron.schedule(
    'hyperdata-sync-account', '* * * * *',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := jsonb_build_object('scheduled_at', now()))$job$,
      project_url || '/functions/v1/sync-hyperliquid-account',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', monitor_secret, 'Content-Type', 'application/json')::text)
  );
end;
$$;

revoke all on function public.claim_hyperliquid_account_source(integer) from public, anon, authenticated;
revoke all on function public.finish_hyperliquid_account_sync(uuid, boolean, bigint, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.configure_hyperliquid_account_cron() from public, anon, authenticated;
grant execute on function public.claim_hyperliquid_account_source(integer) to service_role;
grant execute on function public.finish_hyperliquid_account_sync(uuid, boolean, bigint, bigint, bigint, text) to service_role;
grant execute on function public.configure_hyperliquid_account_cron() to service_role;

insert into public.hyperliquid_account_sources (user_id, address)
select id, '0x003b9e3e0cfd28ba45a3723e393c5443c92792ac'
from auth.users
where lower(email) = 'jasonblick@zohomail.com'
on conflict (user_id) do update set address = excluded.address, active = true, updated_at = now();
