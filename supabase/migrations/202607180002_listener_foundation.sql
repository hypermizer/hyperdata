create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.valid_alert_configuration(detector_name text, config jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case detector_name
    when 'fixed_price' then
      config ?& array['direction', 'target']
      and config ->> 'direction' in ('above', 'below')
      and jsonb_typeof(config -> 'target') = 'number'
      and (config ->> 'target')::double precision > 0
    when 'large_move' then
      config ?& array['direction', 'horizon_minutes', 'tail_percentile', 'minimum_move_percent']
      and config ->> 'direction' in ('up', 'down', 'either')
      and jsonb_typeof(config -> 'horizon_minutes') = 'number'
      and (config ->> 'horizon_minutes')::integer between 1 and 10080
      and mod((config ->> 'horizon_minutes')::numeric, 1) = 0
      and jsonb_typeof(config -> 'tail_percentile') = 'number'
      and (config ->> 'tail_percentile')::double precision between 0.9 and 0.9999
      and jsonb_typeof(config -> 'minimum_move_percent') = 'number'
      and (config ->> 'minimum_move_percent')::double precision >= 0
    else false
  end;
$$;

create table public.alert_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  asset text not null check (asset ~ '^[a-zA-Z0-9_.:-]+$'),
  dex text not null default '',
  detector text not null,
  detector_version integer not null default 1 check (detector_version > 0),
  configuration jsonb not null,
  delivery text not null default 'email' check (delivery in ('email', 'sms')),
  enabled boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_rules_valid_configuration
    check (public.valid_alert_configuration(detector, configuration))
);

create index alert_rules_active_idx
on public.alert_rules (asset, detector)
where enabled and deleted_at is null;

create trigger alert_rules_set_updated_at
before update on public.alert_rules
for each row execute function public.set_updated_at();

create table public.market_observations (
  asset text not null,
  dex text not null default '',
  bucket timestamptz not null,
  observed_at timestamptz not null,
  mark_price double precision not null check (mark_price > 0 and mark_price < 'Infinity'::double precision),
  oracle_price double precision check (oracle_price > 0 and oracle_price < 'Infinity'::double precision),
  mid_price double precision check (mid_price > 0 and mid_price < 'Infinity'::double precision),
  open_interest double precision check (open_interest >= 0 and open_interest < 'Infinity'::double precision),
  day_volume double precision check (day_volume >= 0 and day_volume < 'Infinity'::double precision),
  primary key (asset, bucket)
);

create index market_observations_bucket_idx on public.market_observations (bucket);

create table public.detector_models (
  id uuid primary key default extensions.gen_random_uuid(),
  asset text not null,
  horizon_minutes integer not null check (horizon_minutes between 1 and 10080),
  detector text not null default 'large_move',
  model_version text not null,
  source text not null check (source in ('trade_candle_bootstrap', 'mark_history')),
  parameters jsonb not null,
  sample_count integer not null check (sample_count >= 0),
  coverage_start timestamptz,
  coverage_end timestamptz,
  valid_from timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (asset, horizon_minutes, detector, model_version)
);

create index detector_models_current_idx
on public.detector_models (asset, horizon_minutes, detector, expires_at desc);

create table public.calibration_jobs (
  asset text not null,
  horizon_minutes integer not null check (horizon_minutes between 1 and 10080),
  state text not null default 'queued' check (state in ('queued', 'claimed', 'complete', 'failed')),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (asset, horizon_minutes)
);

create trigger calibration_jobs_set_updated_at
before update on public.calibration_jobs
for each row execute function public.set_updated_at();

create table public.monitor_runs (
  bucket timestamptz primary key,
  state text not null check (state in ('claimed', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  lease_until timestamptz,
  assets_checked integer not null default 0,
  rules_checked integer not null default 0,
  occurrences_created integer not null default 0,
  details jsonb not null default '{}'::jsonb
);

create table public.rule_evaluation_state (
  rule_id uuid primary key references public.alert_rules (id) on delete cascade,
  bucket timestamptz not null,
  status text not null check (status in ('not_triggered', 'triggered', 'warming', 'data_gap', 'error')),
  score double precision,
  tail_percentile double precision,
  reference_age_seconds integer,
  model_version text,
  details jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.alert_occurrences (
  id uuid primary key default extensions.gen_random_uuid(),
  rule_id uuid not null references public.alert_rules (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket timestamptz not null,
  asset text not null,
  detector text not null,
  mark_price double precision not null check (mark_price > 0 and mark_price < 'Infinity'::double precision),
  classification text not null default 'uncertain'
    check (classification in ('fixed_price', 'underlying_move', 'venue_dislocation', 'uncertain')),
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  unique (rule_id, bucket)
);

create index alert_occurrences_user_created_idx
on public.alert_occurrences (user_id, created_at desc);

create table public.notification_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  occurrence_id uuid not null references public.alert_occurrences (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  state text not null default 'queued'
    check (state in ('queued', 'claimed', 'retry_wait', 'sent', 'ambiguous', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  provider_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (occurrence_id, channel)
);

create index notification_outbox_due_idx
on public.notification_outbox (next_attempt_at, created_at)
where state in ('queued', 'retry_wait', 'claimed');

create trigger notification_outbox_set_updated_at
before update on public.notification_outbox
for each row execute function public.set_updated_at();

alter table public.alert_rules enable row level security;
alter table public.market_observations enable row level security;
alter table public.detector_models enable row level security;
alter table public.calibration_jobs enable row level security;
alter table public.monitor_runs enable row level security;
alter table public.rule_evaluation_state enable row level security;
alter table public.alert_occurrences enable row level security;
alter table public.notification_outbox enable row level security;

create policy "Owner manages alert rules"
on public.alert_rules for all to authenticated
using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com')
with check (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');

create policy "Owner reads occurrences"
on public.alert_occurrences for select to authenticated
using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');

create policy "Owner reads delivery status"
on public.notification_outbox for select to authenticated
using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');

create policy "Owner reads rule state"
on public.rule_evaluation_state for select to authenticated
using (exists (
  select 1 from public.alert_rules r
  where r.id = rule_id and r.user_id = auth.uid()
    and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'
));

create policy "Owner reads monitor health"
on public.monitor_runs for select to authenticated
using (auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');

create or replace function public.create_alert_rule(
  p_asset text,
  p_dex text,
  p_detector text,
  p_configuration jsonb,
  p_delivery text default 'email'
)
returns public.alert_rules
language plpgsql
security invoker
set search_path = public, auth
as $$
declare
  created public.alert_rules;
begin
  if auth.uid() is null or auth.jwt() ->> 'email' <> 'jasonblick@zohomail.com' then
    raise exception 'not authorized';
  end if;

  insert into public.alert_rules (user_id, asset, dex, detector, configuration, delivery)
  values (auth.uid(), trim(p_asset), coalesce(trim(p_dex), ''), p_detector, p_configuration, p_delivery)
  returning * into created;

  if p_detector = 'large_move' then
    insert into public.calibration_jobs (asset, horizon_minutes)
    values (created.asset, (p_configuration ->> 'horizon_minutes')::integer)
    on conflict (asset, horizon_minutes) do update
      set state = 'queued', available_at = least(public.calibration_jobs.available_at, now());
  end if;

  return created;
end;
$$;

create or replace function public.set_alert_rule_enabled(p_rule_id uuid, p_enabled boolean)
returns public.alert_rules
language plpgsql
security invoker
set search_path = public, auth
as $$
declare
  changed public.alert_rules;
begin
  update public.alert_rules
  set enabled = p_enabled
  where id = p_rule_id and user_id = auth.uid() and deleted_at is null
  returning * into changed;
  if changed.id is null then raise exception 'rule not found'; end if;
  return changed;
end;
$$;

create or replace function public.delete_alert_rule(p_rule_id uuid)
returns public.alert_rules
language plpgsql
security invoker
set search_path = public, auth
as $$
declare
  changed public.alert_rules;
begin
  update public.alert_rules
  set enabled = false, deleted_at = now()
  where id = p_rule_id and user_id = auth.uid() and deleted_at is null
  returning * into changed;
  if changed.id is null then raise exception 'rule not found'; end if;
  return changed;
end;
$$;

create or replace function public.record_alert_occurrence(
  p_rule_id uuid,
  p_bucket timestamptz,
  p_mark_price double precision,
  p_classification text,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  source_rule public.alert_rules;
  v_occurrence_id uuid;
begin
  select * into source_rule from public.alert_rules
  where id = p_rule_id and enabled and deleted_at is null
  for update;

  if source_rule.id is null then return null; end if;

  insert into public.alert_occurrences (
    rule_id, user_id, bucket, asset, detector, mark_price, classification, evidence
  ) values (
    source_rule.id, source_rule.user_id, p_bucket, source_rule.asset,
    source_rule.detector, p_mark_price, p_classification, p_evidence
  )
  on conflict (rule_id, bucket) do nothing
  returning id into v_occurrence_id;

  if v_occurrence_id is null then
    select id into v_occurrence_id from public.alert_occurrences
    where rule_id = p_rule_id and bucket = p_bucket;
    return v_occurrence_id;
  end if;

  insert into public.notification_outbox (occurrence_id, user_id, channel)
  values (v_occurrence_id, source_rule.user_id, source_rule.delivery)
  on conflict (occurrence_id, channel) do nothing;

  if source_rule.detector = 'fixed_price' then
    update public.alert_rules set enabled = false where id = source_rule.id;
  end if;

  return v_occurrence_id;
end;
$$;

create or replace function public.claim_outbox(p_limit integer default 20)
returns setof public.notification_outbox
language sql
security definer
set search_path = public
as $$
  with due as (
    select id
    from public.notification_outbox
    where (
      state in ('queued', 'retry_wait') and next_attempt_at <= now()
    ) or (
      state = 'claimed' and lease_until < now()
    )
    order by next_attempt_at, created_at
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.notification_outbox o
  set state = 'claimed', lease_until = now() + interval '2 minutes', attempts = attempts + 1
  from due
  where o.id = due.id
  returning o.*;
$$;

create or replace function public.claim_calibration_jobs(p_limit integer default 5)
returns setof public.calibration_jobs
language sql
security definer
set search_path = public
as $$
  with due as (
    select asset, horizon_minutes
    from public.calibration_jobs
    where (state in ('queued', 'failed') and available_at <= now())
       or (state = 'claimed' and lease_until < now())
    order by available_at
    for update skip locked
    limit greatest(1, least(p_limit, 20))
  )
  update public.calibration_jobs j
  set state = 'claimed', lease_until = now() + interval '2 minutes', attempts = attempts + 1
  from due
  where j.asset = due.asset and j.horizon_minutes = due.horizon_minutes
  returning j.*;
$$;

create or replace function public.prune_listener_history()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  observation_count integer;
  run_count integer;
begin
  delete from public.market_observations where bucket < now() - interval '30 days';
  get diagnostics observation_count = row_count;
  delete from public.monitor_runs where bucket < now() - interval '14 days';
  get diagnostics run_count = row_count;
  return jsonb_build_object('observations', observation_count, 'runs', run_count);
end;
$$;

revoke all on function public.record_alert_occurrence(uuid, timestamptz, double precision, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_outbox(integer) from public, anon, authenticated;
revoke all on function public.claim_calibration_jobs(integer) from public, anon, authenticated;
revoke all on function public.prune_listener_history() from public, anon, authenticated;
grant execute on function public.record_alert_occurrence(uuid, timestamptz, double precision, text, jsonb) to service_role;
grant execute on function public.claim_outbox(integer) to service_role;
grant execute on function public.claim_calibration_jobs(integer) to service_role;
grant execute on function public.prune_listener_history() to service_role;
grant execute on function public.create_alert_rule(text, text, text, jsonb, text) to authenticated;
grant execute on function public.set_alert_rule_enabled(uuid, boolean) to authenticated;
grant execute on function public.delete_alert_rule(uuid) to authenticated;
