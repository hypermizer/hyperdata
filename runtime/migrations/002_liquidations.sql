create table if not exists liquidation_requests (
 asset text primary key check(asset ~ '^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$' and length(asset)<=100),
 requested_at timestamptz not null default now(), watch_until timestamptz not null default now(),
 next_fetch_at timestamptz not null default now(), status text not null default 'pending', last_error text,
 history_requested boolean not null default false, history_start timestamptz, history_end timestamptz,
 history_cursor text, history_complete boolean not null default false, history_next_at timestamptz not null default now()
);
create table if not exists liquidation_snapshots (
 asset text not null references liquidation_requests(asset), snapshot_at timestamptz not null,
 payload jsonb not null, fetched_at timestamptz not null default now(), primary key(asset,snapshot_at)
);
create table if not exists liquidation_fetch_log (
 id bigint generated always as identity primary key, fetched_at timestamptz not null default now(),
 asset text not null, kind text not null, status integer
);
create index if not exists liquidation_fetch_time on liquidation_fetch_log(fetched_at);
create table if not exists liquidation_provider_state (
 id boolean primary key default true check(id), cooldown_until timestamptz,
 status text not null default 'ready', credits_remaining integer, credits_reset bigint,
 updated_at timestamptz not null default now(), collector_heartbeat timestamptz
);
insert into liquidation_provider_state(id) values(true) on conflict do nothing;
insert into runtime_migrations(version) values(2) on conflict do nothing;
