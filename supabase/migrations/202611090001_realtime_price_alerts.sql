-- Independent channel delivery and a continuously supervised mark-price listener.
alter table public.alert_rules drop constraint alert_rules_delivery_check;
alter table public.alert_rules add constraint alert_rules_delivery_check check (delivery in ('email', 'sms', 'both'));
alter table public.alert_rules alter column delivery set default 'both';
alter table public.notification_outbox drop constraint notification_outbox_channel_check;
alter table public.notification_outbox add constraint notification_outbox_channel_check check (channel in ('email', 'sms', 'ntfy'));

create function public.fixed_alert_delivery()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.detector = 'fixed_price' then new.delivery := 'both'; end if;
  return new;
end;
$$;
create trigger fixed_alert_delivery before insert or update on public.alert_rules
for each row execute function public.fixed_alert_delivery();
update public.alert_rules set delivery = 'both' where detector = 'fixed_price';

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
  if source_rule.detector = 'fixed_price' then
    -- Recheck under the same lock that disables the rule. Both engines can race safely.
    if p_mark_price <= 0 or not (p_mark_price < 'Infinity'::double precision) then return null; end if;
    if p_evidence ? 'ruleUpdatedAt' and
       (p_evidence ->> 'ruleUpdatedAt')::timestamptz <> source_rule.updated_at then return null; end if;
    if p_evidence ? 'observedAt' and (
      (p_evidence ->> 'observedAt')::timestamptz < source_rule.updated_at or
      (p_evidence ->> 'observedAt')::timestamptz > clock_timestamp() + interval '5 seconds'
    ) then return null; end if;
    if not (case source_rule.configuration ->> 'direction'
      when 'above' then p_mark_price >= (source_rule.configuration ->> 'target')::double precision
      when 'below' then p_mark_price <= (source_rule.configuration ->> 'target')::double precision
      else false end) then return null; end if;
    p_evidence := p_evidence || jsonb_build_object(
      'direction', source_rule.configuration ->> 'direction', 'target', source_rule.configuration -> 'target');
    if p_evidence ? 'observedAt' then p_bucket := (p_evidence ->> 'observedAt')::timestamptz; end if;
  end if;

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
  select v_occurrence_id, source_rule.user_id, channel
  from unnest(case when source_rule.detector = 'fixed_price' or source_rule.delivery = 'both'
    then array['email', 'ntfy'] else array[source_rule.delivery] end) as channel
  on conflict (occurrence_id, channel) do nothing;

  if source_rule.detector = 'fixed_price' then
    update public.alert_rules set enabled = false where id = source_rule.id;
    insert into public.rule_evaluation_state(rule_id, bucket, status, details)
    values (source_rule.id, p_bucket, 'triggered', p_evidence)
    on conflict (rule_id) do update set bucket = excluded.bucket, status = 'triggered',
      details = excluded.details, updated_at = now();
  end if;

  return v_occurrence_id;
end;
$$;


-- Fence finalization to the exact claim; an expired sender cannot finalize a newer lease.
drop function public.finalize_outbox(uuid, text, text, text, timestamptz);
create function public.finalize_outbox(
  p_id uuid, p_state text, p_provider_id text default null, p_error text default null,
  p_next_attempt_at timestamptz default null, p_attempt integer default null
)
returns boolean language plpgsql security definer set search_path = public as $$
declare changed boolean;
begin
  if p_state not in ('sent', 'retry_wait', 'ambiguous', 'failed') then raise exception 'invalid outbox state'; end if;
  update public.notification_outbox
  set state = p_state, provider_id = p_provider_id, last_error = left(p_error, 500),
      next_attempt_at = coalesce(p_next_attempt_at, next_attempt_at), lease_until = null
  where id = p_id and state = 'claimed' and attempts = p_attempt and lease_until > now()
  returning true into changed;
  return coalesce(changed, false);
end;
$$;
revoke all on function public.finalize_outbox(uuid, text, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.finalize_outbox(uuid, text, text, text, timestamptz, integer) to service_role;

create table public.price_stream_health (
  worker_id text primary key,
  heartbeat_at timestamptz not null default now(),
  connected boolean not null,
  last_market_at timestamptz,
  rules_refreshed_at timestamptz,
  active_assets integer not null default 0,
  pending_occurrences integer not null default 0,
  unhealthy_since timestamptz,
  oldest_pending_at timestamptz,
  reconnects integer not null default 0,
  stale_assets jsonb not null default '[]'::jsonb
);
alter table public.price_stream_health enable row level security;
create policy "Owner reads price stream health" on public.price_stream_health for select to authenticated
using (auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');
grant select on public.price_stream_health to authenticated;
grant all on public.price_stream_health to service_role;

-- Wake the worker on rule changes; polling still recovers missed realtime events.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
    and schemaname = 'public' and tablename = 'alert_rules') then
    alter publication supabase_realtime add table public.alert_rules;
  end if;
end $$;

create or replace function public.configure_listener_cron()
returns void
language plpgsql
security definer
set search_path = public, cron, vault
as $$
declare
  project_url text;
  service_key text;
  monitor_secret text;
begin
  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into monitor_secret from vault.decrypted_secrets where name = 'monitor_secret';

  if project_url is null or service_key is null or monitor_secret is null then
    raise exception 'Vault secrets project_url, service_role_key, and monitor_secret are required';
  end if;

  perform cron.unschedule(jobid) from cron.job
  where jobname in ('hyperdata-monitor-market', 'hyperdata-rebuild-calibrations', 'hyperdata-deliver-alerts', 'hyperdata-prune-listener');

  perform cron.schedule(
    'hyperdata-monitor-market', '15 seconds',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := jsonb_build_object('scheduled_at', now()))$job$,
      project_url || '/functions/v1/monitor-market',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', monitor_secret, 'Content-Type', 'application/json')::text)
  );
  perform cron.schedule(
    'hyperdata-rebuild-calibrations', '*/15 * * * *',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb)$job$,
      project_url || '/functions/v1/rebuild-calibrations',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', monitor_secret, 'Content-Type', 'application/json')::text)
  );
  perform cron.schedule(
    'hyperdata-deliver-alerts', '15 seconds',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb)$job$,
      project_url || '/functions/v1/deliver-alerts',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', monitor_secret, 'Content-Type', 'application/json')::text)
  );
  perform cron.schedule('hyperdata-prune-listener', '17 3 * * *', 'select public.prune_listener_history()');
end;
$$;

revoke all on function public.configure_listener_cron() from public, anon, authenticated;
grant execute on function public.configure_listener_cron() to service_role;

-- This watchdog runs in the independent fallback monitor, including when the EC2
-- listener is stopped. Persist claims so overlapping monitors cannot spam warnings.
create table public.price_alert_watchdog (
  id boolean primary key default true check (id),
  problem text,
  notify_after timestamptz not null default now() + interval '2 minutes'
);
insert into public.price_alert_watchdog(id) values (true);
alter table public.price_alert_watchdog enable row level security;
grant all on public.price_alert_watchdog to service_role;

create function public.claim_price_alert_incident()
returns text language plpgsql security definer set search_path = public as $$
declare
  stream public.price_stream_health;
  previous public.price_alert_watchdog;
  detected_problem text;
  message text;
begin
  select * into previous from public.price_alert_watchdog where id for update;
  select * into stream from public.price_stream_health order by heartbeat_at desc limit 1;
  if stream.worker_id is null or stream.heartbeat_at < now() - interval '45 seconds'
    or stream.last_market_at is null or stream.last_market_at < now() - interval '45 seconds'
    or stream.rules_refreshed_at is null or stream.rules_refreshed_at < now() - interval '45 seconds'
    or stream.unhealthy_since < now() - interval '45 seconds' then
    detected_problem := 'Live price listener is offline or stale. The 15-second backup monitor remains active; brief price touches may be missed until the stream recovers.';
  elsif stream.oldest_pending_at < now() - interval '30 seconds' then
    detected_problem := 'Live price detections are awaiting database persistence. The durable local queue is retrying.';
  end if;
  if exists (select 1 from public.notification_outbox where
    (state in ('failed', 'ambiguous') and updated_at > now() - interval '24 hours') or
    (state in ('queued', 'retry_wait', 'claimed') and created_at < now() - interval '2 minutes')) then
    detected_problem := concat_ws(' ', detected_problem, 'Price notification delivery needs attention. Check the separate email and iPhone statuses in Alerts.');
  end if;
  if detected_problem is null then
    if previous.problem is not null then message := 'Price alert monitoring and delivery have recovered.'; end if;
    update public.price_alert_watchdog set problem = null, notify_after = now() where id;
  elsif now() >= previous.notify_after then
    message := detected_problem;
    update public.price_alert_watchdog set problem = detected_problem, notify_after = now() + interval '15 minutes' where id;
  end if;
  return message;
end;
$$;
revoke all on function public.claim_price_alert_incident() from public, anon, authenticated;
grant execute on function public.claim_price_alert_incident() to service_role;
