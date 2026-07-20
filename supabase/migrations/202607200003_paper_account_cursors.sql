create table public.paper_account_market_cursors (
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  asset text not null,
  last_trade_id text,
  last_timestamp_ms bigint,
  input_version text not null,
  updated_at timestamptz not null default now(),
  primary key (epoch_id, asset)
);

alter table public.paper_account_market_cursors enable row level security;
revoke all on table public.paper_account_market_cursors from public, anon, authenticated;
grant all privileges on table public.paper_account_market_cursors to service_role;

create or replace function public.apply_paper_account_snapshot(
  p_epoch_id uuid,
  p_expected_version bigint,
  p_asset text,
  p_replay_effects jsonb,
  p_funding_effects jsonb,
  p_mark_price numeric,
  p_input_version text,
  p_cursor jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare current_version bigint;
declare effect jsonb;
declare applied boolean;
begin
  select version into current_version from public.paper_account_epochs
  where id = p_epoch_id and state = 'active' for update;
  if current_version is null or current_version <> p_expected_version then return false; end if;

  for effect in select value from jsonb_array_elements(coalesce(p_replay_effects, '[]'::jsonb)) loop
    select public.apply_paper_replay_effect(p_epoch_id, current_version, effect) into applied;
    if not applied then raise exception 'paper replay effect rejected'; end if;
    current_version := current_version + 1;
  end loop;

  for effect in select value from jsonb_array_elements(coalesce(p_funding_effects, '[]'::jsonb)) loop
    select public.apply_paper_funding_effect(p_epoch_id, current_version, p_asset, effect) into applied;
    if not applied then raise exception 'paper funding effect rejected'; end if;
    current_version := current_version + 1;
  end loop;

  select public.revalue_paper_epoch_asset(
    p_epoch_id, current_version, p_asset, p_mark_price, p_input_version
  ) into applied;
  if not applied then raise exception 'paper revaluation rejected'; end if;

  insert into public.paper_account_market_cursors (
    epoch_id, asset, last_trade_id, last_timestamp_ms, input_version, updated_at
  ) values (
    p_epoch_id, p_asset, nullif(p_cursor ->> 'lastTradeId', ''),
    nullif(p_cursor ->> 'lastTimestampMs', '')::bigint, p_input_version, now()
  ) on conflict (epoch_id, asset) do update set
    last_trade_id = excluded.last_trade_id,
    last_timestamp_ms = excluded.last_timestamp_ms,
    input_version = excluded.input_version,
    updated_at = now();
  return true;
end;
$$;

revoke all on function public.apply_paper_account_snapshot(uuid, bigint, text, jsonb, jsonb, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_paper_account_snapshot(uuid, bigint, text, jsonb, jsonb, numeric, text, jsonb)
  to service_role;
