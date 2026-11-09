-- A service-role controlled handoff guard keeps stale browsers and future legacy
-- scheduler deployments from reviving a second alert engine after cutover.
create table public.alert_runtime_destination(
 id boolean primary key default true check(id),
 active boolean not null default false,
 origin text not null default ''
);
insert into public.alert_runtime_destination(id) values(true);
alter table public.alert_runtime_destination enable row level security;
grant all on public.alert_runtime_destination to service_role;
create function public.guard_migrated_alert_rules()
returns trigger language plpgsql security definer set search_path=public as $$
declare destination public.alert_runtime_destination;
begin
 select * into destination from public.alert_runtime_destination where id;
 if destination.active and auth.role()='authenticated' then
  raise exception 'Alerts moved to the private server: %/#/alerts',destination.origin;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
create trigger guard_migrated_alert_rules before insert or update or delete on public.alert_rules
for each row execute function public.guard_migrated_alert_rules();
-- Keep occurrence logic intact, with a fast service-side handoff guard.
alter function public.record_alert_occurrence(uuid,timestamptz,double precision,text,jsonb) rename to record_legacy_alert_occurrence;
create function public.record_alert_occurrence(p_rule_id uuid,p_bucket timestamptz,p_mark_price double precision,p_classification text,p_evidence jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.alert_runtime_destination where active) then return null; end if;
 return public.record_legacy_alert_occurrence(p_rule_id,p_bucket,p_mark_price,p_classification,p_evidence);
end;
$$;
revoke all on function public.record_alert_occurrence(uuid,timestamptz,double precision,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_alert_occurrence(uuid,timestamptz,double precision,text,jsonb) to service_role;
-- A future backend deployment must preserve the selected runtime.
alter function public.configure_listener_cron() rename to configure_legacy_listener_cron;
create function public.configure_listener_cron()
returns void language plpgsql security definer set search_path=public,cron as $$
begin
 if exists(select 1 from public.alert_runtime_destination where active) then
  perform cron.unschedule(jobid) from cron.job where jobname in ('hyperdata-monitor-market','hyperdata-rebuild-calibrations','hyperdata-deliver-alerts');
  return;
 end if;
 perform public.configure_legacy_listener_cron();
end;
$$;
revoke all on function public.configure_listener_cron() from public,anon,authenticated;
grant execute on function public.configure_listener_cron() to service_role;
-- Legacy internal functions are no longer directly callable by API service clients.
revoke execute on function public.record_legacy_alert_occurrence(uuid,timestamptz,double precision,text,jsonb) from service_role;
revoke execute on function public.configure_legacy_listener_cron() from service_role;
