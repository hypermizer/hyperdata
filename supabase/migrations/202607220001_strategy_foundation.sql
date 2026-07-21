create table public.strategy_definitions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  strategy_kind text not null check (strategy_kind = 'dual_relative_rsi'),
  active_revision_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index strategy_definitions_owner_name_uidx
on public.strategy_definitions(user_id, lower(trim(name))) where archived_at is null;

create table public.strategy_revisions (
  id uuid primary key default extensions.gen_random_uuid(),
  definition_id uuid not null references public.strategy_definitions(id) on delete cascade,
  revision_number integer not null check (revision_number > 0),
  schema_version integer not null default 1 check (schema_version = 1),
  parameters jsonb not null,
  created_at timestamptz not null default now(),
  unique(definition_id, revision_number),
  check (
    parameters @> '{"rsiPeriod":14,"baselineLength":100,"shortRatio":"1.9","longRatio":"0.1","stopReturn":"-0.1","takeReturn":"0.2"}'::jsonb
    and (parameters->>'marginAllocationPct')::numeric between 1 and 100
  )
);

alter table public.strategy_definitions
  add constraint strategy_definitions_active_revision_fk
  foreign key(active_revision_id) references public.strategy_revisions(id);

create table public.strategy_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  revision_id uuid not null references public.strategy_revisions(id),
  account_id uuid not null references public.paper_accounts(id) on delete cascade,
  epoch_id uuid not null references public.paper_account_epochs(id) on delete cascade,
  asset text not null check (asset ~ '^[a-zA-Z0-9_.:-]+$'),
  margin_allocation_pct numeric(6,3) not null default 10 check (margin_allocation_pct between 1 and 100),
  state text not null default 'paused' check (state in ('paused','warming','armed','position_open','await_rearm','exit_managed_paused','degraded')),
  rearm_ready boolean not null default true,
  last_five_minute_close timestamptz,
  last_one_hour_close timestamptz,
  degraded_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index strategy_assignments_one_controller_idx
on public.strategy_assignments(epoch_id, asset)
where state <> 'paused';

create table public.strategy_candles (
  asset text not null,
  interval text not null check (interval in ('5m','1h')),
  open_time timestamptz not null,
  close_time timestamptz not null,
  open numeric(38,12) not null check (open > 0),
  high numeric(38,12) not null check (high > 0),
  low numeric(38,12) not null check (low > 0),
  close numeric(38,12) not null check (close > 0),
  volume numeric(38,12) not null check (volume >= 0),
  source text not null default 'hyperliquid',
  source_version text not null,
  collected_at timestamptz not null default now(),
  primary key(asset, interval, open_time),
  check(close_time > open_time and high >= greatest(open, close) and low <= least(open, close))
);

create table public.strategy_evaluations (
  id uuid primary key default extensions.gen_random_uuid(),
  assignment_id uuid not null references public.strategy_assignments(id) on delete cascade,
  five_minute_close timestamptz not null,
  one_hour_close timestamptz,
  five_minute_values jsonb,
  one_hour_values jsonb,
  decision text not null check (decision in ('warming','hold','enter_long','enter_short','degraded')),
  input_versions jsonb not null default '{}'::jsonb,
  reason text,
  created_at timestamptz not null default now(),
  unique(assignment_id, five_minute_close)
);

create table public.strategy_positions (
  id uuid primary key default extensions.gen_random_uuid(),
  assignment_id uuid not null references public.strategy_assignments(id) on delete cascade,
  paper_position_id uuid references public.paper_positions(id),
  side text not null check (side in ('long','short')),
  entry_size numeric(38,12) not null check (entry_size > 0),
  entry_price numeric(38,12) not null check (entry_price > 0),
  entry_initial_margin numeric(38,6) not null check (entry_initial_margin > 0),
  entry_fees numeric(38,6) not null default 0 check (entry_fees >= 0),
  funding_cashflows numeric(38,6) not null default 0,
  state text not null default 'open' check (state in ('open','closing','closed','liquidated')),
  exit_reason text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index strategy_positions_one_open_idx
on public.strategy_positions(assignment_id) where state in ('open','closing');

create table public.strategy_actions (
  id uuid primary key default extensions.gen_random_uuid(),
  assignment_id uuid not null references public.strategy_assignments(id) on delete cascade,
  evaluation_id uuid references public.strategy_evaluations(id),
  action_kind text not null check (action_kind in ('entry','exit','pause_close')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  paper_command_id uuid references public.paper_commands(id),
  state text not null default 'pending' check (state in ('pending','succeeded','failed')),
  payload jsonb not null default '{}'::jsonb,
  outcome jsonb,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(assignment_id, idempotency_key)
);

create table public.backtest_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  revision_id uuid not null references public.strategy_revisions(id),
  assets text[] not null check (cardinality(assets) between 1 and 20),
  requested_start timestamptz not null,
  requested_end timestamptz not null,
  actual_start timestamptz,
  actual_end timestamptz,
  initial_capital numeric(38,6) not null default 5000 check (initial_capital > 0),
  status text not null default 'queued' check (status in ('queued','running','completed','degraded','failed')),
  work_cursor jsonb not null default '{}'::jsonb,
  progress integer not null default 0 check (progress between 0 and 100),
  assumptions jsonb not null default '{}'::jsonb,
  fidelity jsonb not null default '{"signal":"exact","execution":"bar_conservative","constraints":"current_constraints"}'::jsonb,
  metrics jsonb,
  result_hash text,
  failure_reason text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check(requested_end > requested_start)
);

create table public.backtest_trades (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  asset text not null,
  side text not null check (side in ('long','short')),
  entry_time timestamptz not null,
  entry_price numeric(38,12) not null,
  exit_time timestamptz not null,
  exit_price numeric(38,12) not null,
  initial_margin numeric(38,6) not null,
  gross_pnl numeric(38,6) not null,
  fees numeric(38,6) not null,
  funding numeric(38,6) not null,
  net_pnl numeric(38,6) not null,
  exit_reason text not null,
  fidelity jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.backtest_equity_points (
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  sampled_at timestamptz not null,
  equity numeric(38,6) not null,
  reason text not null check (reason in ('hourly','entry','exit','start','end')),
  primary key(run_id, sampled_at, reason)
);

create or replace function public.reject_strategy_revision_mutation()
returns trigger language plpgsql as $$ begin raise exception 'strategy revisions are immutable'; end $$;
create trigger strategy_revisions_immutable before update or delete on public.strategy_revisions
for each row execute function public.reject_strategy_revision_mutation();

create trigger strategy_definitions_set_updated_at before update on public.strategy_definitions
for each row execute function public.set_updated_at();
create trigger strategy_assignments_set_updated_at before update on public.strategy_assignments
for each row execute function public.set_updated_at();
create trigger strategy_actions_set_updated_at before update on public.strategy_actions
for each row execute function public.set_updated_at();

create or replace function public.create_dual_rsi_strategy(p_name text, p_margin_allocation_pct numeric default 10)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare owner_id uuid := public.require_paper_owner(); definition_id uuid; revision_id uuid;
begin
  if p_margin_allocation_pct not between 1 and 100 then raise exception 'margin allocation must be between 1 and 100'; end if;
  insert into public.strategy_definitions(user_id,name,strategy_kind)
  values(owner_id,trim(p_name),'dual_relative_rsi') returning id into definition_id;
  insert into public.strategy_revisions(definition_id,revision_number,parameters)
  values(definition_id,1,jsonb_build_object('rsiPeriod',14,'baselineLength',100,'shortRatio','1.9','longRatio','0.1','stopReturn','-0.1','takeReturn','0.2','marginAllocationPct',p_margin_allocation_pct::text))
  returning id into revision_id;
  update public.strategy_definitions set active_revision_id=revision_id where id=definition_id;
  return definition_id;
end $$;

create or replace function public.create_strategy_assignment(p_definition_id uuid, p_account_id uuid, p_asset text, p_margin_allocation_pct numeric default 10)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare owner_id uuid := public.require_paper_owner(); revision_id uuid; epoch_id uuid; assignment_id uuid;
begin
  if p_margin_allocation_pct not between 1 and 100 then raise exception 'margin allocation must be between 1 and 100'; end if;
  select d.active_revision_id into revision_id from public.strategy_definitions d where d.id=p_definition_id and d.user_id=owner_id and d.archived_at is null;
  if revision_id is null then raise exception 'strategy definition not found'; end if;
  select e.id into epoch_id from public.paper_accounts a join public.paper_account_epochs e on e.account_id=a.id and e.epoch_number=a.active_epoch
  where a.id=p_account_id and a.user_id=owner_id and a.archived_at is null and e.state='active';
  if epoch_id is null then raise exception 'paper account epoch is not active'; end if;
  insert into public.strategy_assignments(user_id,revision_id,account_id,epoch_id,asset,margin_allocation_pct)
  values(owner_id,revision_id,p_account_id,epoch_id,p_asset,p_margin_allocation_pct) returning id into assignment_id;
  return assignment_id;
end $$;

create or replace function public.set_strategy_assignment_state(p_assignment_id uuid, p_state text, p_pause_mode text default null)
returns boolean language plpgsql security definer set search_path = public, auth as $$
declare owner_id uuid := public.require_paper_owner(); current_state text; has_position boolean;
begin
  if p_state not in ('paused','warming') then raise exception 'unsupported assignment transition'; end if;
  select state into current_state from public.strategy_assignments where id=p_assignment_id and user_id=owner_id for update;
  if current_state is null then raise exception 'strategy assignment not found'; end if;
  select exists(select 1 from public.strategy_positions where assignment_id=p_assignment_id and state in ('open','closing')) into has_position;
  if p_state='paused' and has_position then
    if p_pause_mode='keep_exit_management' then
      update public.strategy_assignments set state='exit_managed_paused' where id=p_assignment_id;
    elsif p_pause_mode='close_and_pause' then
      update public.strategy_assignments set state='position_open', degraded_reason='close_and_pause_requested' where id=p_assignment_id;
      insert into public.strategy_actions(assignment_id,action_kind,idempotency_key,payload)
      values(p_assignment_id,'pause_close','strategy:pause:'||p_assignment_id::text,jsonb_build_object('pauseAfterClose',true)) on conflict do nothing;
    else raise exception 'open position pause requires keep_exit_management or close_and_pause'; end if;
  else
    update public.strategy_assignments set state=p_state, degraded_reason=null where id=p_assignment_id;
  end if;
  return true;
end $$;

create or replace function public.queue_strategy_backtest(p_revision_id uuid, p_assets text[], p_start timestamptz, p_end timestamptz, p_initial_capital numeric default 5000)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare owner_id uuid := public.require_paper_owner(); run_id uuid;
begin
  if p_initial_capital <= 0 then raise exception 'initial capital must be positive'; end if;
  if not exists(select 1 from public.strategy_revisions r join public.strategy_definitions d on d.id=r.definition_id where r.id=p_revision_id and d.user_id=owner_id) then raise exception 'strategy revision not found'; end if;
  insert into public.backtest_runs(user_id,revision_id,assets,requested_start,requested_end,initial_capital)
  values(owner_id,p_revision_id,p_assets,p_start,p_end,p_initial_capital) returning id into run_id;
  return run_id;
end $$;

do $$ declare table_name text; begin
  foreach table_name in array array['strategy_definitions','strategy_revisions','strategy_assignments','strategy_candles','strategy_evaluations','strategy_positions','strategy_actions','backtest_runs','backtest_trades','backtest_equity_points'] loop
    execute format('alter table public.%I enable row level security',table_name);
  end loop;
end $$;

create policy "Owner reads strategy definitions" on public.strategy_definitions for select to authenticated using(user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy "Owner reads strategy revisions" on public.strategy_revisions for select to authenticated using(exists(select 1 from public.strategy_definitions d where d.id=definition_id and d.user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com'));
create policy "Owner reads strategy assignments" on public.strategy_assignments for select to authenticated using(user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy "Owner reads strategy evaluations" on public.strategy_evaluations for select to authenticated using(exists(select 1 from public.strategy_assignments a where a.id=assignment_id and a.user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com'));
create policy "Owner reads strategy positions" on public.strategy_positions for select to authenticated using(exists(select 1 from public.strategy_assignments a where a.id=assignment_id and a.user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com'));
create policy "Owner reads strategy actions" on public.strategy_actions for select to authenticated using(exists(select 1 from public.strategy_assignments a where a.id=assignment_id and a.user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com'));
create policy "Owner reads backtest runs" on public.backtest_runs for select to authenticated using(user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy "Owner reads backtest trades" on public.backtest_trades for select to authenticated using(exists(select 1 from public.backtest_runs r where r.id=run_id and r.user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com'));
create policy "Owner reads backtest equity" on public.backtest_equity_points for select to authenticated using(exists(select 1 from public.backtest_runs r where r.id=run_id and r.user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com'));

revoke all on table public.strategy_definitions,public.strategy_revisions,public.strategy_assignments,public.strategy_candles,public.strategy_evaluations,public.strategy_positions,public.strategy_actions,public.backtest_runs,public.backtest_trades,public.backtest_equity_points from public,anon,authenticated;
grant select on table public.strategy_definitions,public.strategy_revisions,public.strategy_assignments,public.strategy_evaluations,public.strategy_positions,public.strategy_actions,public.backtest_runs,public.backtest_trades,public.backtest_equity_points to authenticated;
grant all on table public.strategy_definitions,public.strategy_revisions,public.strategy_assignments,public.strategy_candles,public.strategy_evaluations,public.strategy_positions,public.strategy_actions,public.backtest_runs,public.backtest_trades,public.backtest_equity_points to service_role;

revoke all on function public.create_dual_rsi_strategy(text,numeric),public.create_strategy_assignment(uuid,uuid,text,numeric),public.set_strategy_assignment_state(uuid,text,text),public.queue_strategy_backtest(uuid,text[],timestamptz,timestamptz,numeric) from public,anon,authenticated;

create or replace function public.configure_strategy_mutation_access(p_enabled boolean default false)
returns void language plpgsql security definer set search_path=public as $$ begin
  if p_enabled then
    grant execute on function public.create_dual_rsi_strategy(text,numeric) to authenticated;
    grant execute on function public.create_strategy_assignment(uuid,uuid,text,numeric) to authenticated;
    grant execute on function public.set_strategy_assignment_state(uuid,text,text) to authenticated;
    grant execute on function public.queue_strategy_backtest(uuid,text[],timestamptz,timestamptz,numeric) to authenticated;
  else
    revoke execute on function public.create_dual_rsi_strategy(text,numeric) from authenticated;
    revoke execute on function public.create_strategy_assignment(uuid,uuid,text,numeric) from authenticated;
    revoke execute on function public.set_strategy_assignment_state(uuid,text,text) from authenticated;
    revoke execute on function public.queue_strategy_backtest(uuid,text[],timestamptz,timestamptz,numeric) from authenticated;
  end if;
end $$;

revoke all on function public.configure_strategy_mutation_access(boolean) from public,anon,authenticated;
grant execute on function public.configure_strategy_mutation_access(boolean) to service_role;
