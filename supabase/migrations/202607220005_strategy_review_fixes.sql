create or replace function public.create_dual_rsi_revision(p_definition_id uuid, p_margin_allocation_pct numeric)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare
  owner_id uuid := public.require_paper_owner();
  next_number integer;
  revision_id uuid;
begin
  if p_margin_allocation_pct not between 1 and 100 then raise exception 'margin allocation must be between 1 and 100'; end if;
  perform 1 from public.strategy_definitions
  where id=p_definition_id and user_id=owner_id and archived_at is null for update;
  if not found then raise exception 'strategy definition not found'; end if;
  select coalesce(max(revision_number),0)+1 into next_number
  from public.strategy_revisions where definition_id=p_definition_id;
  insert into public.strategy_revisions(definition_id,revision_number,parameters)
  values(p_definition_id,next_number,jsonb_build_object(
    'rsiPeriod',14,'baselineLength',100,'shortRatio','1.9','longRatio','0.1',
    'stopReturn','-0.1','takeReturn','0.2','marginAllocationPct',p_margin_allocation_pct::text
  )) returning id into revision_id;
  update public.strategy_definitions set active_revision_id=revision_id where id=p_definition_id;
  return revision_id;
end $$;

create or replace function public.create_strategy_assignment(p_definition_id uuid, p_account_id uuid, p_asset text, p_margin_allocation_pct numeric default 10)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare owner_id uuid := public.require_paper_owner(); revision_id uuid; v_epoch_id uuid; assignment_id uuid;
begin
  if p_margin_allocation_pct not between 1 and 100 then raise exception 'margin allocation must be between 1 and 100'; end if;
  select d.active_revision_id into revision_id from public.strategy_definitions d
  where d.id=p_definition_id and d.user_id=owner_id and d.archived_at is null;
  if revision_id is null then raise exception 'strategy definition not found'; end if;
  select e.id into v_epoch_id from public.paper_accounts a join public.paper_account_epochs e
    on e.account_id=a.id and e.epoch_number=a.active_epoch
  where a.id=p_account_id and a.user_id=owner_id and a.archived_at is null and e.state='active';
  if v_epoch_id is null then raise exception 'paper account epoch is not active'; end if;
  if exists(select 1 from public.paper_positions p where p.epoch_id=v_epoch_id and p.asset=p_asset) then
    raise exception 'asset already has a paper position; close it before assigning a strategy';
  end if;
  insert into public.strategy_assignments(user_id,revision_id,account_id,epoch_id,asset,margin_allocation_pct)
  values(owner_id,revision_id,p_account_id,v_epoch_id,p_asset,p_margin_allocation_pct) returning id into assignment_id;
  return assignment_id;
end $$;

create or replace function public.set_strategy_assignment_state(p_assignment_id uuid, p_state text, p_pause_mode text default null)
returns boolean language plpgsql security definer set search_path = public, auth as $$
declare
  owner_id uuid := public.require_paper_owner();
  current_state text;
  open_position_id uuid;
  active_epoch boolean;
begin
  if p_state not in ('paused','warming') then raise exception 'unsupported assignment transition'; end if;
  select a.state, exists(
    select 1 from public.paper_accounts p join public.paper_account_epochs e
      on e.account_id=p.id and e.epoch_number=p.active_epoch and e.state='active'
    where p.id=a.account_id and e.id=a.epoch_id and p.archived_at is null
  ) into current_state,active_epoch
  from public.strategy_assignments a where a.id=p_assignment_id and a.user_id=owner_id for update;
  if current_state is null then raise exception 'strategy assignment not found'; end if;
  select id into open_position_id from public.strategy_positions
  where assignment_id=p_assignment_id and state in ('open','closing') for update;
  if p_state='warming' and not active_epoch then raise exception 'assignment epoch is no longer active'; end if;
  if p_state='warming' and open_position_id is null and (
    exists(select 1 from public.paper_positions p join public.strategy_assignments a on a.epoch_id=p.epoch_id and a.asset=p.asset where a.id=p_assignment_id)
    or exists(select 1 from public.paper_orders o join public.strategy_assignments a on a.epoch_id=o.epoch_id and a.asset=o.asset
      where a.id=p_assignment_id and o.status in ('resting','trigger_waiting','partially_filled'))
  ) then raise exception 'asset has manual paper exposure; close or cancel it before enabling the strategy'; end if;
  if p_state='paused' and open_position_id is not null then
    if p_pause_mode='keep_exit_management' then
      update public.strategy_assignments set state='exit_managed_paused',degraded_reason=null where id=p_assignment_id;
    elsif p_pause_mode='close_and_pause' then
      update public.strategy_assignments set state='position_open',degraded_reason='close_and_pause_requested' where id=p_assignment_id;
      insert into public.strategy_actions(assignment_id,action_kind,idempotency_key,payload)
      values(p_assignment_id,'pause_close','strategy:pause:'||open_position_id::text,jsonb_build_object('pauseAfterClose',true))
      on conflict do nothing;
    else raise exception 'open position pause requires keep_exit_management or close_and_pause'; end if;
  elsif p_state='warming' and open_position_id is not null then
    update public.strategy_assignments set state='position_open',degraded_reason=null where id=p_assignment_id;
  else
    update public.strategy_assignments set state=p_state,degraded_reason=null where id=p_assignment_id;
  end if;
  return true;
end $$;

create or replace function public.queue_strategy_backtest(p_revision_id uuid, p_assets text[], p_start timestamptz, p_end timestamptz, p_initial_capital numeric default 5000)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare owner_id uuid := public.require_paper_owner(); run_id uuid;
begin
  if p_initial_capital <= 0 then raise exception 'initial capital must be positive'; end if;
  if p_end <= p_start then raise exception 'backtest end must be after start'; end if;
  if cardinality(p_assets) not between 1 and 20 or exists(select 1 from unnest(p_assets) as u(value) where value !~ '^[a-zA-Z0-9_.:-]+$') then
    raise exception 'invalid backtest assets';
  end if;
  if (select count(*) from unnest(p_assets)) <> (select count(distinct value) from unnest(p_assets) as u(value)) then
    raise exception 'backtest assets must be unique';
  end if;
  if not exists(select 1 from public.strategy_revisions r join public.strategy_definitions d on d.id=r.definition_id where r.id=p_revision_id and d.user_id=owner_id) then
    raise exception 'strategy revision not found';
  end if;
  insert into public.backtest_runs(user_id,revision_id,assets,requested_start,requested_end,initial_capital)
  values(owner_id,p_revision_id,p_assets,p_start,p_end,p_initial_capital) returning id into run_id;
  return run_id;
end $$;

create or replace function public.configure_strategy_mutation_access(p_enabled boolean default false)
returns void language plpgsql security definer set search_path=public as $$ begin
  if p_enabled then
    grant execute on function public.create_dual_rsi_strategy(text,numeric) to authenticated;
    grant execute on function public.create_dual_rsi_revision(uuid,numeric) to authenticated;
    grant execute on function public.create_strategy_assignment(uuid,uuid,text,numeric) to authenticated;
    grant execute on function public.set_strategy_assignment_state(uuid,text,text) to authenticated;
    grant execute on function public.queue_strategy_backtest(uuid,text[],timestamptz,timestamptz,numeric) to authenticated;
  else
    revoke execute on function public.create_dual_rsi_strategy(text,numeric) from authenticated;
    revoke execute on function public.create_dual_rsi_revision(uuid,numeric) from authenticated;
    revoke execute on function public.create_strategy_assignment(uuid,uuid,text,numeric) from authenticated;
    revoke execute on function public.set_strategy_assignment_state(uuid,text,text) from authenticated;
    revoke execute on function public.queue_strategy_backtest(uuid,text[],timestamptz,timestamptz,numeric) from authenticated;
  end if;
end $$;

revoke all on function public.create_dual_rsi_revision(uuid,numeric) from public,anon,authenticated;

alter table public.backtest_trades add column scope text not null default 'asset'
check(scope in ('asset','portfolio'));
create unique index backtest_trades_replay_uidx
on public.backtest_trades(run_id,scope,asset,side,entry_time,exit_time);
