create or replace function public.ensure_strategy_shadow()
returns uuid
language plpgsql
security definer
set search_path=public,auth
as $$
declare v_owner_id uuid; v_account_id uuid; v_epoch_id uuid; v_definition_id uuid; v_revision_id uuid; asset_name text;
begin
  select id into v_owner_id from auth.users where lower(email)='jasonblick@zohomail.com' order by created_at limit 1;
  if v_owner_id is null then raise exception 'strategy owner user does not exist'; end if;
  v_account_id := public.ensure_paper_shadow_account();
  select e.id into v_epoch_id from public.paper_accounts a join public.paper_account_epochs e on e.account_id=a.id and e.epoch_number=a.active_epoch where a.id=v_account_id and e.state='active';
  select id,active_revision_id into v_definition_id,v_revision_id from public.strategy_definitions where user_id=v_owner_id and name='__SHADOW__ DUAL RSI' and archived_at is null;
  if v_definition_id is null then
    insert into public.strategy_definitions(user_id,name,strategy_kind) values(v_owner_id,'__SHADOW__ DUAL RSI','dual_relative_rsi') returning id into v_definition_id;
    insert into public.strategy_revisions(definition_id,revision_number,parameters) values(v_definition_id,1,'{"rsiPeriod":14,"baselineLength":100,"shortRatio":"1.9","longRatio":"0.1","stopReturn":"-0.1","takeReturn":"0.2","marginAllocationPct":"10"}'::jsonb) returning id into v_revision_id;
    update public.strategy_definitions set active_revision_id=v_revision_id where id=v_definition_id;
  end if;
  foreach asset_name in array array['xyz:DRAM','xyz:XYZ100','BTC'] loop
    if not exists(select 1 from public.strategy_assignments where epoch_id=v_epoch_id and asset=asset_name and revision_id=v_revision_id) then
      insert into public.strategy_assignments(user_id,revision_id,account_id,epoch_id,asset,margin_allocation_pct,state)
      values(v_owner_id,v_revision_id,v_account_id,v_epoch_id,asset_name,10,'warming');
    end if;
  end loop;
  return v_definition_id;
end $$;

create or replace function public.ensure_initial_strategy_backtest()
returns uuid
language plpgsql
security definer
set search_path=public,auth
as $$
declare v_definition_id uuid; v_revision_id uuid; v_owner_id uuid; v_run_id uuid;
begin
  v_definition_id := public.ensure_strategy_shadow();
  select user_id,active_revision_id into v_owner_id,v_revision_id from public.strategy_definitions where id=v_definition_id;
  select id into v_run_id from public.backtest_runs where user_id=v_owner_id and assumptions->>'initialRun'='dual-rsi-v1' order by created_at desc limit 1;
  if v_run_id is not null then return v_run_id; end if;
  insert into public.backtest_runs(user_id,revision_id,assets,requested_start,requested_end,initial_capital,assumptions)
  values(v_owner_id,v_revision_id,array['xyz:DRAM','xyz:XYZ100','BTC'],now()-interval '17 days',now(),5000,'{"initialRun":"dual-rsi-v1"}'::jsonb)
  returning id into v_run_id;
  return v_run_id;
end $$;

create or replace view public.strategy_operational_health
with (security_invoker=true)
as
select
  (select count(*) from public.strategy_assignments where state<>'paused')::integer as active_assignments,
  (select count(*) from public.strategy_assignments a where a.state<>'paused' and exists(select 1 from public.strategy_evaluations e where e.assignment_id=a.id and e.created_at>now()-interval '10 minutes'))::integer as fresh_assignments,
  (select count(*) from public.strategy_assignments where state='degraded')::integer as degraded_assignments,
  (select count(*) from public.strategy_actions where state='failed')::integer as failed_actions,
  (select count(*) from public.backtest_runs where status in ('queued','running'))::integer as pending_backtests,
  (select count(*) from public.backtest_runs where status='completed')::integer as completed_backtests,
  (select count(*) from public.backtest_runs where status='failed')::integer as failed_backtests,
  (select max(created_at) from public.strategy_evaluations) as latest_evaluation_at;

revoke all on function public.ensure_strategy_shadow(),public.ensure_initial_strategy_backtest() from public,anon,authenticated;
grant execute on function public.ensure_strategy_shadow(),public.ensure_initial_strategy_backtest() to service_role;
revoke all on table public.strategy_operational_health from public,anon,authenticated;
grant select on table public.strategy_operational_health to authenticated,service_role;
