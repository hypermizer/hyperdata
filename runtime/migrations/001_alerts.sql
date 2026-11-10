create table if not exists runtime_migrations(version integer primary key, applied_at timestamptz not null default now());
create table if not exists alert_rules (
 id uuid primary key default gen_random_uuid(), user_id uuid not null,
 asset text not null check(asset ~ '^[a-zA-Z0-9_.:-]+$'), dex text not null default '',
 detector text not null check(detector in ('fixed_price','large_move')), detector_version integer not null default 1,
 configuration jsonb not null, delivery text not null default 'ntfy' check(delivery='ntfy'),
 enabled boolean not null default true, deleted_at timestamptz,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create index if not exists active_alert_rules on alert_rules(asset) where enabled and deleted_at is null;
create table if not exists alert_occurrences (
 id uuid primary key default gen_random_uuid(), rule_id uuid not null references alert_rules(id), user_id uuid not null,
 bucket timestamptz not null, asset text not null, detector text not null, mark_price double precision not null check(mark_price>0 and mark_price<'Infinity'::double precision),
 classification text not null, evidence jsonb not null, dedupe_key text not null,
 created_at timestamptz not null default clock_timestamp(), unique(rule_id,dedupe_key)
);
create table if not exists notification_outbox (
 id uuid primary key default gen_random_uuid(), occurrence_id uuid not null references alert_occurrences(id), user_id uuid not null,
 channel text not null check(channel in ('email','ntfy')), state text not null default 'queued' check(state in ('queued','claimed','retry_wait','sent','ambiguous','failed')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(), lease_until timestamptz, lease_token uuid,
 provider_id text, last_error text, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(occurrence_id,channel)
);
create index if not exists due_notifications on notification_outbox(next_attempt_at) where state in ('queued','retry_wait','claimed');
create table if not exists rule_evaluation_state(rule_id uuid primary key references alert_rules(id),bucket timestamptz not null,status text not null,details jsonb not null default '{}',updated_at timestamptz not null default clock_timestamp());
create table if not exists runtime_health(worker_id text primary key,heartbeat_at timestamptz not null default clock_timestamp(),details jsonb not null default '{}');
create table if not exists market_observations(asset text not null,bucket timestamptz not null,observation jsonb not null,primary key(asset,bucket));
create table if not exists detector_models(asset text not null,horizon_minutes integer not null,model jsonb not null,expires_at timestamptz not null,primary key(asset,horizon_minutes));
create table if not exists volatility_states(asset text primary key,state jsonb not null);
create table if not exists revoked_clients(fingerprint text primary key,revoked_at timestamptz not null default clock_timestamp());
create table if not exists audit_events(id bigint generated always as identity primary key,created_at timestamptz not null default clock_timestamp(),action text not null,rule_id uuid,client_fingerprint text);
create table if not exists runtime_settings(key text primary key,value jsonb not null);
insert into runtime_settings(key,value) values('active','false'),('delivery_enabled','true') on conflict do nothing;
insert into runtime_migrations(version) values(1) on conflict do nothing;
create or replace function notify_alert_rules() returns trigger language plpgsql as $$
begin perform pg_notify('hyperdata_rules','changed'); return null; end;
$$;
drop trigger if exists notify_alert_rules on alert_rules;
create trigger notify_alert_rules after insert or update or delete on alert_rules for each statement execute function notify_alert_rules();
