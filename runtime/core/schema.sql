-- Canonical local application schema, captured at migration 202611090004.
-- No user data or credentials. Historical hosted scheduling RPCs are revoked by localize.sql.
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Ubuntu 17.11-1.pgdg24.04+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: apply_paper_account_snapshot(uuid, bigint, text, jsonb, jsonb, numeric, text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.apply_paper_account_snapshot(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_replay_effects jsonb, p_funding_effects jsonb, p_mark_price numeric, p_input_version text, p_cursor jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


ALTER FUNCTION public.apply_paper_account_snapshot(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_replay_effects jsonb, p_funding_effects jsonb, p_mark_price numeric, p_input_version text, p_cursor jsonb) OWNER TO postgres;

--
-- Name: apply_paper_effects(uuid, integer, bigint, text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.apply_paper_effects(p_account_id uuid, p_epoch_number integer, p_expected_version bigint, p_idempotency_key text, p_effects jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  epoch_row public.paper_account_epochs%rowtype;
  stored_result jsonb;
  cash_delta numeric(38, 6);
  order_row_id uuid;
  total_fees numeric(38, 6);
  total_volume numeric(38, 6);
  total_maker_volume numeric(38, 6);
begin
  select e.* into epoch_row
  from public.paper_account_epochs e
  join public.paper_accounts a on a.id = e.account_id
  where e.account_id = p_account_id and e.epoch_number = p_epoch_number
    and e.state = 'active' and a.active_epoch = p_epoch_number and a.archived_at is null
  for update of e;
  if epoch_row.id is null then raise exception 'paper account epoch is not active'; end if;

  select canonical_result into stored_result from public.paper_commands
  where epoch_id = epoch_row.id and idempotency_key = p_idempotency_key;
  if stored_result is not null then return stored_result; end if;
  if epoch_row.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'stale paper account version';
  end if;

  insert into public.paper_commands (epoch_id, idempotency_key, expected_version, canonical_result)
  values (epoch_row.id, p_idempotency_key, p_expected_version, p_effects);

  insert into public.paper_ledger_entries (epoch_id, entry_type, amount, asset, source_timestamp)
  select epoch_row.id, entry_type, amount::numeric, asset, source_timestamp
  from jsonb_to_recordset(coalesce(p_effects -> 'ledger', '[]'::jsonb))
    as x(entry_type text, amount text, asset text, source_timestamp timestamptz);

  if p_effects ? 'order' then
    insert into public.paper_orders (
      epoch_id, client_order_id, asset, side, order_type, time_in_force, margin_mode,
      leverage, size, remaining_size, limit_price, trigger_price, reduce_only, status, queue_ahead,
      reserved_margin, rejection_reason, fidelity, source_timestamp
    ) values (
      epoch_row.id,
      p_idempotency_key,
      p_effects -> 'order' ->> 'asset',
      p_effects -> 'order' ->> 'side',
      p_effects -> 'order' ->> 'orderType',
      p_effects -> 'order' ->> 'timeInForce',
      p_effects -> 'order' ->> 'marginMode',
      (p_effects -> 'order' ->> 'leverage')::integer,
      (p_effects -> 'order' ->> 'requestedSize')::numeric,
      (p_effects -> 'order' ->> 'remainingSize')::numeric,
      nullif(p_effects -> 'order' ->> 'limitPrice', '')::numeric,
      nullif(p_effects -> 'order' ->> 'triggerPrice', '')::numeric,
      coalesce((p_effects -> 'order' ->> 'reduceOnly')::boolean, false),
      p_effects -> 'order' ->> 'status',
      nullif(p_effects -> 'order' ->> 'queueAhead', '')::numeric,
      coalesce((p_effects -> 'order' ->> 'reservedMargin')::numeric, 0),
      p_effects -> 'response' ->> 'reason',
      p_effects -> 'response' ->> 'fidelity',
      (p_effects -> 'response' ->> 'sourceTimestamp')::timestamptz
    ) returning id into order_row_id;
    insert into public.paper_leverage_settings (epoch_id, asset, margin_mode, leverage)
    values (
      epoch_row.id, p_effects -> 'order' ->> 'asset',
      p_effects -> 'order' ->> 'marginMode', (p_effects -> 'order' ->> 'leverage')::integer
    ) on conflict (epoch_id, asset) do update set
      margin_mode = excluded.margin_mode, leverage = excluded.leverage, updated_at = now();
  end if;

  insert into public.paper_fills (
    epoch_id, order_id, asset, side, liquidity, size, price, fee,
    source_id, source_timestamp, input_version, fidelity
  )
  select
    epoch_row.id,
    order_row_id,
    p_effects -> 'order' ->> 'asset',
    p_effects -> 'order' ->> 'side',
    fill.liquidity,
    fill.size::numeric,
    fill.price::numeric,
    fill.fee::numeric,
    fill."sourceId",
    (p_effects -> 'response' ->> 'sourceTimestamp')::timestamptz,
    p_effects -> 'inputVersions' ->> 'book',
    p_effects -> 'response' ->> 'fidelity'
  from jsonb_to_recordset(coalesce(p_effects -> 'fills', '[]'::jsonb))
    as fill(price text, size text, fee text, liquidity text, "sourceId" text);

  if jsonb_array_length(coalesce(p_effects -> 'fills', '[]'::jsonb)) > 0 then
    if p_effects -> 'positionProjection' = 'null'::jsonb then
      delete from public.paper_positions
      where epoch_id = epoch_row.id and asset = p_effects -> 'order' ->> 'asset';
    else
      insert into public.paper_positions (
        epoch_id, asset, margin_mode, signed_size, entry_price, mark_price,
        isolated_margin, realized_pnl, input_version
      ) values (
        epoch_row.id,
        p_effects -> 'positionProjection' ->> 'asset',
        p_effects -> 'positionProjection' ->> 'marginMode',
        (p_effects -> 'positionProjection' ->> 'signedSize')::numeric,
        (p_effects -> 'positionProjection' ->> 'entryPrice')::numeric,
        (p_effects -> 'positionProjection' ->> 'markPrice')::numeric,
        case when p_effects -> 'positionProjection' ->> 'marginMode' = 'isolated'
          then abs((p_effects -> 'positionProjection' ->> 'signedSize')::numeric)
            * (p_effects -> 'positionProjection' ->> 'markPrice')::numeric
            / (p_effects -> 'positionProjection' ->> 'leverage')::integer
          else null end,
        coalesce((
          select sum((entry ->> 'amount')::numeric)
          from jsonb_array_elements(coalesce(p_effects -> 'ledger', '[]'::jsonb)) entry
          where entry ->> 'entry_type' = 'realized_pnl'
            and (entry ->> 'asset') = (p_effects -> 'positionProjection' ->> 'asset')
        ), 0),
        p_effects -> 'positionProjection' ->> 'inputVersion'
      )
      on conflict (epoch_id, asset) do update set
        margin_mode = excluded.margin_mode,
        signed_size = excluded.signed_size,
        entry_price = excluded.entry_price,
        mark_price = excluded.mark_price,
        isolated_margin = excluded.isolated_margin,
        realized_pnl = paper_positions.realized_pnl + excluded.realized_pnl,
        input_version = excluded.input_version,
        updated_at = now();
    end if;
  end if;

  select coalesce(sum((entry ->> 'amount')::numeric), 0) into cash_delta
  from jsonb_array_elements(coalesce(p_effects -> 'ledger', '[]'::jsonb)) entry;
  select
    coalesce(sum((fill ->> 'fee')::numeric), 0),
    coalesce(sum((fill ->> 'size')::numeric * (fill ->> 'price')::numeric), 0),
    coalesce(sum(case when fill ->> 'liquidity' = 'maker'
      then (fill ->> 'size')::numeric * (fill ->> 'price')::numeric else 0 end), 0)
  into total_fees, total_volume, total_maker_volume
  from jsonb_array_elements(coalesce(p_effects -> 'fills', '[]'::jsonb)) fill;
  update public.paper_account_summaries
  set cash_balance = cash_balance + cash_delta,
      equity = equity + cash_delta,
      withdrawable = withdrawable + cash_delta,
      realized_pnl = realized_pnl + coalesce((
        select sum((entry ->> 'amount')::numeric)
        from jsonb_array_elements(coalesce(p_effects -> 'ledger', '[]'::jsonb)) entry
        where entry ->> 'entry_type' = 'realized_pnl'
      ), 0),
      cumulative_fees = cumulative_fees + total_fees,
      trailing_volume = trailing_volume + total_volume,
      maker_volume = maker_volume + total_maker_volume,
      reconciled_at = now()
  where epoch_id = epoch_row.id;
  update public.paper_account_summaries summary set
    unrealized_pnl = totals.unrealized,
    equity = summary.cash_balance + totals.unrealized,
    total_notional = totals.notional,
    fidelity = 'live'
  from (
    select
      coalesce(sum(signed_size * (mark_price - entry_price)), 0)::numeric(38, 6) as unrealized,
      coalesce(sum(abs(signed_size) * mark_price), 0)::numeric(38, 6) as notional
    from public.paper_positions where epoch_id = epoch_row.id
  ) totals
  where summary.epoch_id = epoch_row.id;
  update public.paper_account_epochs set version = version + 1 where id = epoch_row.id;
  return p_effects;
end;
$$;


ALTER FUNCTION public.apply_paper_effects(p_account_id uuid, p_epoch_number integer, p_expected_version bigint, p_idempotency_key text, p_effects jsonb) OWNER TO postgres;

--
-- Name: apply_paper_funding_effect(uuid, bigint, text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.apply_paper_funding_effect(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_effect jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare current_version bigint;
declare payment_id uuid;
declare payment_amount numeric(38, 6) := (p_effect ->> 'payment')::numeric;
begin
  select version into current_version from public.paper_account_epochs
  where id = p_epoch_id and state = 'active' for update;
  if current_version is null or current_version <> p_expected_version then return false; end if;

  insert into public.paper_funding_payments (
    epoch_id, asset, funding_timestamp, signed_size, oracle_price,
    funding_rate, payment, input_version
  ) values (
    p_epoch_id, p_asset, (p_effect ->> 'fundingTimestamp')::timestamptz,
    (p_effect ->> 'signedSize')::numeric, (p_effect ->> 'oraclePrice')::numeric,
    (p_effect ->> 'fundingRate')::numeric, payment_amount, p_effect ->> 'inputVersion'
  ) on conflict (epoch_id, asset, funding_timestamp) do nothing
  returning id into payment_id;
  if payment_id is null then return true; end if;

  insert into public.paper_ledger_entries (
    epoch_id, entry_type, amount, asset, reference_id, source_timestamp
  ) values (
    p_epoch_id, 'funding', payment_amount, p_asset, payment_id,
    (p_effect ->> 'fundingTimestamp')::timestamptz
  );
  update public.paper_positions set
    cumulative_funding = cumulative_funding + payment_amount,
    updated_at = now()
  where epoch_id = p_epoch_id and asset = p_asset;
  update public.paper_account_summaries set
    cash_balance = cash_balance + payment_amount,
    equity = equity + payment_amount,
    withdrawable = withdrawable + payment_amount,
    cumulative_funding = cumulative_funding + payment_amount,
    reconciled_at = now()
  where epoch_id = p_epoch_id;
  update public.paper_account_epochs set version = version + 1 where id = p_epoch_id;
  return true;
end;
$$;


ALTER FUNCTION public.apply_paper_funding_effect(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_effect jsonb) OWNER TO postgres;

--
-- Name: apply_paper_liquidation_effect(uuid, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.apply_paper_liquidation_effect(p_epoch_id uuid, p_expected_version bigint, p_effect jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare current_version bigint;
declare liquidation_id uuid;
declare total_fee numeric(38, 6) := coalesce((p_effect ->> 'totalFee')::numeric, 0);
declare total_realized numeric(38, 6) := coalesce((p_effect ->> 'realizedPnl')::numeric, 0);
declare total_volume numeric(38, 6) := 0;
declare cash_delta numeric(38, 6);
declare isolated_shortfall numeric(38, 6) := 0;
begin
  select version into current_version from public.paper_account_epochs
  where id = p_epoch_id and state = 'active' for update;
  if current_version is null or current_version <> p_expected_version then return false; end if;

  update public.paper_orders set
    status = 'canceled', rejection_reason = 'liquidation', reserved_margin = 0, updated_at = now()
  where epoch_id = p_epoch_id and status in ('resting', 'partially_filled', 'trigger_waiting')
    and (
      p_effect ->> 'marginMode' <> 'isolated'
      or asset = p_effect ->> 'asset'
    );

  insert into public.paper_liquidations (
    epoch_id, asset, classification, trigger_snapshot, attempted_fills,
    maintenance_margin, remaining_equity, cooldown_until,
    source_timestamp, input_version
  ) values (
    p_epoch_id, p_effect ->> 'asset', p_effect ->> 'classification',
    p_effect -> 'triggerSnapshot', coalesce(p_effect -> 'fills', '[]'::jsonb),
    (p_effect ->> 'maintenanceMargin')::numeric, (p_effect ->> 'remainingEquity')::numeric,
    nullif(p_effect ->> 'cooldownUntil', '')::timestamptz,
    (p_effect ->> 'sourceTimestamp')::timestamptz, p_effect ->> 'inputVersion'
  ) returning id into liquidation_id;

  insert into public.paper_fills (
    epoch_id, order_id, asset, side, liquidity, size, price, fee,
    source_id, source_timestamp, input_version, fidelity
  ) select p_epoch_id, null, p_effect ->> 'asset',
    case when (p_effect -> 'triggerSnapshot' ->> 'signedSize')::numeric > 0 then 'sell' else 'buy' end,
    'liquidation', fill.size::numeric, fill.price::numeric, fill.fee::numeric,
    fill."sourceId", (p_effect ->> 'sourceTimestamp')::timestamptz,
    p_effect ->> 'inputVersion',
    case when p_effect ->> 'classification' = 'backstop' then 'degraded' else 'exact_book' end
  from jsonb_to_recordset(coalesce(p_effect -> 'fills', '[]'::jsonb))
    as fill(price text, size text, fee text, liquidity text, "sourceId" text)
  on conflict (epoch_id, source_id) do nothing;

  select coalesce(sum((fill ->> 'size')::numeric * (fill ->> 'price')::numeric), 0)
  into total_volume from jsonb_array_elements(coalesce(p_effect -> 'fills', '[]'::jsonb)) fill;
  cash_delta := total_realized - total_fee;
  if p_effect ->> 'marginMode' = 'isolated' then
    cash_delta := greatest(cash_delta, -coalesce((p_effect ->> 'isolatedMargin')::numeric, 0));
    isolated_shortfall := cash_delta - (total_realized - total_fee);
  end if;

  if p_effect -> 'position' = 'null'::jsonb then
    delete from public.paper_positions where epoch_id = p_epoch_id and asset = p_effect ->> 'asset';
  else
    update public.paper_positions set
      signed_size = (p_effect -> 'position' ->> 'signedSize')::numeric,
      entry_price = (p_effect -> 'position' ->> 'entryPrice')::numeric,
      mark_price = (p_effect -> 'triggerSnapshot' ->> 'markPrice')::numeric,
      realized_pnl = realized_pnl + total_realized,
      input_version = p_effect ->> 'inputVersion', updated_at = now()
    where epoch_id = p_epoch_id and asset = p_effect ->> 'asset';
  end if;

  if total_realized <> 0 then
    insert into public.paper_ledger_entries (epoch_id, entry_type, amount, asset, reference_id, source_timestamp)
    values (p_epoch_id, 'liquidation', total_realized, p_effect ->> 'asset', liquidation_id, (p_effect ->> 'sourceTimestamp')::timestamptz);
  end if;
  if total_fee <> 0 then
    insert into public.paper_ledger_entries (epoch_id, entry_type, amount, asset, reference_id, source_timestamp)
    values (p_epoch_id, 'fee', -total_fee, p_effect ->> 'asset', liquidation_id, (p_effect ->> 'sourceTimestamp')::timestamptz);
  end if;
  if isolated_shortfall > 0 then
    insert into public.paper_ledger_entries (epoch_id, entry_type, amount, asset, reference_id, source_timestamp)
    values (p_epoch_id, 'isolated_transfer', isolated_shortfall, p_effect ->> 'asset', liquidation_id, (p_effect ->> 'sourceTimestamp')::timestamptz);
  end if;

  update public.paper_account_summaries set
    cash_balance = cash_balance + cash_delta,
    realized_pnl = realized_pnl + total_realized,
    cumulative_fees = cumulative_fees + total_fee,
    trailing_volume = trailing_volume + total_volume,
    fidelity = case when p_effect ->> 'classification' = 'backstop' then 'degraded' else 'live' end,
    reconciled_at = now()
  where epoch_id = p_epoch_id;
  update public.paper_account_summaries summary set
    unrealized_pnl = totals.unrealized,
    equity = summary.cash_balance + totals.unrealized,
    total_notional = totals.notional,
    maintenance_margin = greatest(
      summary.maintenance_margin
        - coalesce((p_effect ->> 'positionMaintenanceMargin')::numeric, 0)
        + coalesce((p_effect ->> 'remainingPositionMaintenanceMargin')::numeric, 0),
      0
    )
  from (select
      coalesce(sum(signed_size * (mark_price - entry_price)), 0)::numeric(38, 6) as unrealized,
      coalesce(sum(abs(signed_size) * mark_price), 0)::numeric(38, 6) as notional
    from public.paper_positions where epoch_id = p_epoch_id) totals
  where summary.epoch_id = p_epoch_id;
  update public.paper_account_epochs set version = version + 1 where id = p_epoch_id;
  return true;
end;
$$;


ALTER FUNCTION public.apply_paper_liquidation_effect(p_epoch_id uuid, p_expected_version bigint, p_effect jsonb) OWNER TO postgres;

--
-- Name: apply_paper_replay_effect(uuid, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.apply_paper_replay_effect(p_epoch_id uuid, p_expected_version bigint, p_effects jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare epoch_row public.paper_account_epochs%rowtype;
declare order_row public.paper_orders%rowtype;
declare total_fee numeric(38, 6) := 0;
declare total_realized numeric(38, 6) := coalesce((p_effects ->> 'realizedPnl')::numeric, 0);
declare total_volume numeric(38, 6) := 0;
declare total_maker_volume numeric(38, 6) := 0;
declare target_leverage integer;
begin
  select * into epoch_row from public.paper_account_epochs
  where id = p_epoch_id and state = 'active' for update;
  if epoch_row.id is null or epoch_row.version <> p_expected_version then return false; end if;
  select * into order_row from public.paper_orders
  where id = (p_effects ->> 'orderId')::uuid and epoch_id = p_epoch_id
    and status in ('resting', 'partially_filled', 'trigger_waiting') for update;
  if order_row.id is null then return false; end if;

  update public.paper_orders set
    status = p_effects ->> 'status',
    remaining_size = (p_effects ->> 'remainingSize')::numeric,
    queue_ahead = nullif(p_effects ->> 'queueAhead', '')::numeric,
    reserved_margin = case
      when p_effects ->> 'status' in ('resting', 'partially_filled', 'trigger_waiting') then reserved_margin
      else 0
    end,
    fidelity = 'trade_replay',
    source_timestamp = (p_effects ->> 'sourceTimestamp')::timestamptz,
    rejection_reason = p_effects ->> 'reason',
    updated_at = now()
  where id = order_row.id;

  insert into public.paper_fills (
    epoch_id, order_id, asset, side, liquidity, size, price, fee,
    source_id, source_timestamp, input_version, fidelity
  ) select p_epoch_id, order_row.id, order_row.asset, order_row.side,
    fill.liquidity, fill.size::numeric, fill.price::numeric, fill.fee::numeric,
    fill."sourceId", coalesce(fill."sourceTimestamp", p_effects ->> 'sourceTimestamp')::timestamptz,
    p_effects ->> 'inputVersion', 'trade_replay'
  from jsonb_to_recordset(coalesce(p_effects -> 'fills', '[]'::jsonb))
    as fill(price text, size text, fee text, liquidity text, "sourceId" text, "sourceTimestamp" text)
  on conflict (epoch_id, source_id) do nothing;

  select coalesce(sum((fill ->> 'fee')::numeric), 0),
    coalesce(sum((fill ->> 'size')::numeric * (fill ->> 'price')::numeric), 0),
    coalesce(sum(case when fill ->> 'liquidity' = 'maker'
      then (fill ->> 'size')::numeric * (fill ->> 'price')::numeric else 0 end), 0)
  into total_fee, total_volume, total_maker_volume
  from jsonb_array_elements(coalesce(p_effects -> 'fills', '[]'::jsonb)) fill;

  if jsonb_array_length(coalesce(p_effects -> 'fills', '[]'::jsonb)) > 0 then
    if p_effects -> 'position' = 'null'::jsonb then
      delete from public.paper_positions where epoch_id = p_epoch_id and asset = order_row.asset;
    else
      select leverage into target_leverage from public.paper_leverage_settings
      where epoch_id = p_epoch_id and asset = order_row.asset;
      target_leverage := coalesce(target_leverage, 1);
      insert into public.paper_positions (
        epoch_id, asset, margin_mode, signed_size, entry_price, mark_price,
        isolated_margin, realized_pnl, input_version
      ) values (
        p_epoch_id, order_row.asset, order_row.margin_mode,
        (p_effects -> 'position' ->> 'signedSize')::numeric,
        (p_effects -> 'position' ->> 'entryPrice')::numeric,
        (p_effects ->> 'markPrice')::numeric,
        case when order_row.margin_mode = 'isolated' then
          abs((p_effects -> 'position' ->> 'signedSize')::numeric) * (p_effects ->> 'markPrice')::numeric / target_leverage
          else null end,
        total_realized, p_effects ->> 'inputVersion'
      ) on conflict (epoch_id, asset) do update set
        signed_size = excluded.signed_size, entry_price = excluded.entry_price,
        mark_price = excluded.mark_price, isolated_margin = excluded.isolated_margin,
        realized_pnl = public.paper_positions.realized_pnl + total_realized,
        input_version = excluded.input_version, updated_at = now();
    end if;
    if total_realized <> 0 then
      insert into public.paper_ledger_entries (epoch_id, entry_type, amount, asset, reference_id, source_timestamp)
      values (p_epoch_id, 'realized_pnl', total_realized, order_row.asset, order_row.id, (p_effects ->> 'sourceTimestamp')::timestamptz);
    end if;
    if total_fee <> 0 then
      insert into public.paper_ledger_entries (epoch_id, entry_type, amount, asset, reference_id, source_timestamp)
      values (p_epoch_id, 'fee', -total_fee, order_row.asset, order_row.id, (p_effects ->> 'sourceTimestamp')::timestamptz);
    end if;
  end if;

  update public.paper_account_summaries set
    cash_balance = cash_balance + total_realized - total_fee,
    realized_pnl = realized_pnl + total_realized,
    cumulative_fees = cumulative_fees + total_fee,
    trailing_volume = trailing_volume + total_volume,
    maker_volume = maker_volume + total_maker_volume,
    fidelity = 'live', reconciled_at = now()
  where epoch_id = p_epoch_id;
  update public.paper_account_summaries summary set
    unrealized_pnl = totals.unrealized,
    equity = summary.cash_balance + totals.unrealized,
    total_notional = totals.notional
  from (select
      coalesce(sum(signed_size * (mark_price - entry_price)), 0)::numeric(38, 6) as unrealized,
      coalesce(sum(abs(signed_size) * mark_price), 0)::numeric(38, 6) as notional
    from public.paper_positions where epoch_id = p_epoch_id) totals
  where summary.epoch_id = p_epoch_id;
  update public.paper_account_epochs set version = version + 1 where id = p_epoch_id;
  return true;
end;
$$;


ALTER FUNCTION public.apply_paper_replay_effect(p_epoch_id uuid, p_expected_version bigint, p_effects jsonb) OWNER TO postgres;

--
-- Name: archive_paper_account(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.archive_paper_account(p_account_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare changed boolean;
begin
  perform public.require_paper_owner();
  update public.paper_accounts
  set archived_at = now()
  where id = p_account_id and user_id = auth.uid() and archived_at is null
  returning true into changed;
  return coalesce(changed, false);
end;
$$;


ALTER FUNCTION public.archive_paper_account(p_account_id uuid) OWNER TO postgres;

--
-- Name: cancel_paper_order(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.cancel_paper_order(p_account_id uuid, p_order_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare changed boolean;
begin
  perform public.require_paper_owner();
  update public.paper_orders o
  set status = 'canceled', rejection_reason = 'user canceled', reserved_margin = 0, updated_at = now()
  from public.paper_account_epochs e, public.paper_accounts a
  where o.id = p_order_id and o.epoch_id = e.id and e.account_id = a.id
    and a.id = p_account_id and a.user_id = auth.uid() and a.active_epoch = e.epoch_number
    and e.state = 'active' and o.status in ('resting', 'trigger_waiting', 'partially_filled')
  returning true into changed;
  return coalesce(changed, false);
end;
$$;


ALTER FUNCTION public.cancel_paper_order(p_account_id uuid, p_order_id uuid) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: calibration_jobs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.calibration_jobs (
    asset text NOT NULL,
    horizon_minutes integer NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT calibration_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT calibration_jobs_horizon_minutes_check CHECK (((horizon_minutes >= 1) AND (horizon_minutes <= 10080))),
    CONSTRAINT calibration_jobs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'claimed'::text, 'complete'::text, 'failed'::text])))
);


ALTER TABLE public.calibration_jobs OWNER TO postgres;

--
-- Name: claim_calibration_jobs(integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_calibration_jobs(p_limit integer DEFAULT 5) RETURNS SETOF public.calibration_jobs
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with due as (
    select asset, horizon_minutes
    from public.calibration_jobs
    where (state in ('queued', 'failed', 'complete') and available_at <= now())
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


ALTER FUNCTION public.claim_calibration_jobs(p_limit integer) OWNER TO postgres;

--
-- Name: claim_hyperliquid_account_source(integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_hyperliquid_account_source(p_lease_seconds integer DEFAULT 90) RETURNS TABLE(user_id uuid, address text, fills_cursor_ms bigint, funding_cursor_ms bigint, ledger_cursor_ms bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


ALTER FUNCTION public.claim_hyperliquid_account_source(p_lease_seconds integer) OWNER TO postgres;

--
-- Name: claim_monitor_bucket(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_monitor_bucket(p_bucket timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare claimed boolean;
begin
  insert into public.monitor_runs (bucket, state, lease_until)
  values (p_bucket, 'claimed', now() + interval '55 seconds')
  on conflict (bucket) do update
    set state = 'claimed', started_at = now(), finished_at = null,
        lease_until = now() + interval '55 seconds', details = '{}'::jsonb
    where public.monitor_runs.state = 'claimed' and public.monitor_runs.lease_until < now()
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;


ALTER FUNCTION public.claim_monitor_bucket(p_bucket timestamp with time zone) OWNER TO postgres;

--
-- Name: notification_outbox; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notification_outbox (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    occurrence_id uuid NOT NULL,
    user_id uuid NOT NULL,
    channel text NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    provider_id text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT notification_outbox_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'ntfy'::text]))),
    CONSTRAINT notification_outbox_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'claimed'::text, 'retry_wait'::text, 'sent'::text, 'ambiguous'::text, 'failed'::text])))
);


ALTER TABLE public.notification_outbox OWNER TO postgres;

--
-- Name: claim_outbox(integer, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_outbox(p_limit integer DEFAULT 20, p_channel text DEFAULT NULL::text) RETURNS SETOF public.notification_outbox
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with due as (
    select id from public.notification_outbox
    where (p_channel is null or channel = p_channel)
    -- Give the dedicated egress first opportunity before trying shared Edge egress.
    and (p_channel is not null or channel <> 'ntfy' or created_at < now() - interval '10 seconds'
      or not exists (select 1 from public.price_stream_health
        where connected and heartbeat_at > now() - interval '20 seconds'))
    and (
      (state in ('queued', 'retry_wait') and next_attempt_at <= now()) or
      (state = 'claimed' and lease_until < now())
    )
    order by next_attempt_at, created_at for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.notification_outbox o
  set state = 'claimed', lease_until = now() + interval '2 minutes', attempts = attempts + 1
  from due where o.id = due.id returning o.*;
$$;


ALTER FUNCTION public.claim_outbox(p_limit integer, p_channel text) OWNER TO postgres;

--
-- Name: claim_paper_processor_bucket(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_paper_processor_bucket(p_bucket timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare lease_row public.paper_processor_lease%rowtype;
begin
  select * into lease_row from public.paper_processor_lease where singleton for update;

  if exists (select 1 from public.paper_processor_runs where bucket = p_bucket) then
    return false;
  end if;

  if lease_row.lease_until is not null and lease_row.lease_until > now() then
    insert into public.paper_processor_runs (bucket, state, finished_at, lag_seconds, details)
    values (p_bucket, 'overlap', now(), greatest(0, extract(epoch from now() - p_bucket)::integer),
      jsonb_build_object('activeBucket', lease_row.bucket));
    return false;
  end if;

  update public.paper_processor_lease
  set bucket = p_bucket, lease_until = now() + interval '90 seconds'
  where singleton;
  insert into public.paper_processor_runs (bucket, state, lease_until, lag_seconds)
  values (p_bucket, 'claimed', now() + interval '90 seconds',
    greatest(0, extract(epoch from now() - p_bucket)::integer));
  return true;
end;
$$;


ALTER FUNCTION public.claim_paper_processor_bucket(p_bucket timestamp with time zone) OWNER TO postgres;

--
-- Name: claim_price_alert_incident(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_price_alert_incident() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


ALTER FUNCTION public.claim_price_alert_incident() OWNER TO postgres;

--
-- Name: claim_sign_in_email_delivery(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_sign_in_email_delivery(p_now timestamp with time zone DEFAULT now()) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  limiter public.sign_in_email_limits%rowtype;
begin
  insert into public.sign_in_email_limits(limiter_key, window_started_at)
  values ('owner', p_now)
  on conflict (limiter_key) do nothing;

  select * into limiter
  from public.sign_in_email_limits
  where limiter_key = 'owner'
  for update;

  if p_now >= limiter.window_started_at + interval '1 hour' then
    limiter.window_started_at := p_now;
    limiter.attempt_count := 0;
    limiter.last_sent_at := null;
  end if;

  if limiter.last_sent_at is not null and p_now < limiter.last_sent_at + interval '10 seconds' then
    return 'cooldown';
  end if;
  if limiter.attempt_count >= 20 then
    return 'hourly_limit';
  end if;

  update public.sign_in_email_limits
  set window_started_at = limiter.window_started_at,
      last_sent_at = p_now,
      attempt_count = limiter.attempt_count + 1
  where limiter_key = 'owner';
  return 'claimed';
end;
$$;


ALTER FUNCTION public.claim_sign_in_email_delivery(p_now timestamp with time zone) OWNER TO postgres;

--
-- Name: configure_hyperliquid_account_cron(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.configure_hyperliquid_account_cron() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'cron', 'vault'
    AS $_$
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
$_$;


ALTER FUNCTION public.configure_hyperliquid_account_cron() OWNER TO postgres;

--
-- Name: configure_legacy_listener_cron(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.configure_legacy_listener_cron() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'cron', 'vault'
    AS $_$
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
$_$;


ALTER FUNCTION public.configure_legacy_listener_cron() OWNER TO postgres;

--
-- Name: configure_listener_cron(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.configure_listener_cron() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'cron'
    AS $$
begin
 if exists(select 1 from public.alert_runtime_destination where active) then
  perform cron.unschedule(jobid) from cron.job where jobname in ('hyperdata-monitor-market','hyperdata-rebuild-calibrations','hyperdata-deliver-alerts');
  return;
 end if;
 perform public.configure_legacy_listener_cron();
end;
$$;


ALTER FUNCTION public.configure_listener_cron() OWNER TO postgres;

--
-- Name: configure_paper_cron(boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.configure_paper_cron(p_enabled boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'cron', 'vault'
    AS $_$
declare project_url text;
declare service_key text;
declare scheduler_secret text;
begin
  perform cron.unschedule(jobid) from cron.job
  where jobname in ('hyperdata-process-paper', 'hyperdata-prune-paper');
  perform cron.schedule('hyperdata-prune-paper', '41 3 * * *', 'select public.prune_paper_diagnostics()');
  if not p_enabled then return; end if;

  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into scheduler_secret from vault.decrypted_secrets where name = 'paper_scheduler_secret';
  if project_url is null or service_key is null or scheduler_secret is null then
    raise exception 'paper scheduler Vault secrets are required';
  end if;
  perform cron.schedule(
    'hyperdata-process-paper', '10 seconds',
    format($job$select net.http_post(url := %L, headers := %L::jsonb, body := jsonb_build_object('scheduled_at', now()))$job$,
      project_url || '/functions/v1/process-paper',
      jsonb_build_object('Authorization', 'Bearer ' || service_key, 'x-monitor-secret', scheduler_secret, 'Content-Type', 'application/json')::text)
  );
end;
$_$;


ALTER FUNCTION public.configure_paper_cron(p_enabled boolean) OWNER TO postgres;

--
-- Name: configure_paper_mutation_access(boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.configure_paper_mutation_access(p_enabled boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_enabled then
    grant execute on function public.create_paper_account(text, numeric) to authenticated;
    grant execute on function public.rename_paper_account(uuid, text) to authenticated;
    grant execute on function public.archive_paper_account(uuid) to authenticated;
    grant execute on function public.reset_paper_account(uuid) to authenticated;
    grant execute on function public.set_paper_leverage(uuid, text, text, integer, numeric) to authenticated;
    grant execute on function public.cancel_paper_order(uuid, uuid) to authenticated;
  else
    revoke execute on function public.create_paper_account(text, numeric) from authenticated;
    revoke execute on function public.rename_paper_account(uuid, text) from authenticated;
    revoke execute on function public.archive_paper_account(uuid) from authenticated;
    revoke execute on function public.reset_paper_account(uuid) from authenticated;
    revoke execute on function public.set_paper_leverage(uuid, text, text, integer, numeric) from authenticated;
    revoke execute on function public.cancel_paper_order(uuid, uuid) from authenticated;
  end if;
end;
$$;


ALTER FUNCTION public.configure_paper_mutation_access(p_enabled boolean) OWNER TO postgres;

--
-- Name: configure_strategy_mutation_access(boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.configure_strategy_mutation_access(p_enabled boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ begin
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


ALTER FUNCTION public.configure_strategy_mutation_access(p_enabled boolean) OWNER TO postgres;

--
-- Name: valid_alert_configuration(text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.valid_alert_configuration(detector_name text, config jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
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


ALTER FUNCTION public.valid_alert_configuration(detector_name text, config jsonb) OWNER TO postgres;

--
-- Name: alert_rules; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.alert_rules (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    asset text NOT NULL,
    dex text DEFAULT ''::text NOT NULL,
    detector text NOT NULL,
    detector_version integer DEFAULT 1 NOT NULL,
    configuration jsonb NOT NULL,
    delivery text DEFAULT 'both'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alert_rules_asset_check CHECK ((asset ~ '^[a-zA-Z0-9_.:-]+$'::text)),
    CONSTRAINT alert_rules_delivery_check CHECK ((delivery = ANY (ARRAY['email'::text, 'sms'::text, 'both'::text]))),
    CONSTRAINT alert_rules_detector_version_check CHECK ((detector_version > 0)),
    CONSTRAINT alert_rules_valid_configuration CHECK (public.valid_alert_configuration(detector, configuration))
);


ALTER TABLE public.alert_rules OWNER TO postgres;

--
-- Name: create_alert_rule(text, text, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_alert_rule(p_asset text, p_dex text, p_detector text, p_configuration jsonb, p_delivery text DEFAULT 'email'::text) RETURNS public.alert_rules
    LANGUAGE plpgsql
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.create_alert_rule(p_asset text, p_dex text, p_detector text, p_configuration jsonb, p_delivery text) OWNER TO postgres;

--
-- Name: create_dual_rsi_revision(uuid, numeric); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_dual_rsi_revision(p_definition_id uuid, p_margin_allocation_pct numeric) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.create_dual_rsi_revision(p_definition_id uuid, p_margin_allocation_pct numeric) OWNER TO postgres;

--
-- Name: create_dual_rsi_strategy(text, numeric); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_dual_rsi_strategy(p_name text, p_margin_allocation_pct numeric DEFAULT 10) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.create_dual_rsi_strategy(p_name text, p_margin_allocation_pct numeric) OWNER TO postgres;

--
-- Name: create_paper_account(text, numeric); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_paper_account(p_name text, p_starting_capital numeric DEFAULT 5000.000000) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare
  owner_id uuid := public.require_paper_owner();
  account_id uuid;
  epoch_id uuid;
begin
  if p_starting_capital is null or p_starting_capital <= 0 or p_starting_capital > 1000000000 then
    raise exception 'starting capital must be between 0 and 1000000000';
  end if;
  insert into public.paper_accounts (user_id, name, starting_capital)
  values (owner_id, trim(p_name), p_starting_capital)
  returning id into account_id;
  insert into public.paper_account_epochs (account_id, epoch_number)
  values (account_id, 1)
  returning id into epoch_id;
  insert into public.paper_account_summaries (epoch_id, cash_balance, equity)
  values (epoch_id, p_starting_capital, p_starting_capital);
  insert into public.paper_ledger_entries (epoch_id, entry_type, amount)
  values (epoch_id, 'opening_balance', p_starting_capital);
  return account_id;
end;
$$;


ALTER FUNCTION public.create_paper_account(p_name text, p_starting_capital numeric) OWNER TO postgres;

--
-- Name: create_strategy_assignment(uuid, uuid, text, numeric); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_strategy_assignment(p_definition_id uuid, p_account_id uuid, p_asset text, p_margin_allocation_pct numeric DEFAULT 10) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.create_strategy_assignment(p_definition_id uuid, p_account_id uuid, p_asset text, p_margin_allocation_pct numeric) OWNER TO postgres;

--
-- Name: delete_alert_rule(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.delete_alert_rule(p_rule_id uuid) RETURNS public.alert_rules
    LANGUAGE plpgsql
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.delete_alert_rule(p_rule_id uuid) OWNER TO postgres;

--
-- Name: disable_reset_epoch_strategies(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.disable_reset_epoch_strategies() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if old.state='active' and new.state='closed' then
    update public.strategy_assignments set state='paused',degraded_reason='account_epoch_reset' where epoch_id=new.id;
  end if;
  return new;
end $$;


ALTER FUNCTION public.disable_reset_epoch_strategies() OWNER TO postgres;

--
-- Name: ensure_initial_strategy_backtest(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.ensure_initial_strategy_backtest() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.ensure_initial_strategy_backtest() OWNER TO postgres;

--
-- Name: ensure_paper_shadow_account(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.ensure_paper_shadow_account() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare owner_id uuid;
declare account_id uuid;
declare epoch_id uuid;
begin
  select id into owner_id from auth.users where lower(email) = 'jasonblick@zohomail.com' order by created_at limit 1;
  if owner_id is null then raise exception 'paper owner user does not exist'; end if;
  select id into account_id from public.paper_accounts
  where user_id = owner_id and name = '__SHADOW__ ORCL' and archived_at is null;
  if account_id is not null then return account_id; end if;

  insert into public.paper_accounts (user_id, name) values (owner_id, '__SHADOW__ ORCL') returning id into account_id;
  insert into public.paper_account_epochs (account_id, epoch_number) values (account_id, 1) returning id into epoch_id;
  insert into public.paper_account_summaries (epoch_id) values (epoch_id);
  insert into public.paper_ledger_entries (epoch_id, entry_type, amount) values (epoch_id, 'opening_balance', 5000);
  insert into public.paper_positions (
    epoch_id, asset, margin_mode, signed_size, entry_price, mark_price,
    isolated_margin, input_version
  ) values (epoch_id, 'xyz:ORCL', 'isolated', 0.001, 100, 100, 500, 'shadow-seed-v1');
  insert into public.paper_fills (
    epoch_id, asset, side, liquidity, size, price, fee, source_id,
    source_timestamp, input_version, fidelity
  ) values (
    epoch_id, 'xyz:ORCL', 'buy', 'taker', 0.001, 100, 0,
    'shadow-seed-v1', now(), 'shadow-seed-v1', 'reconciled'
  );
  return account_id;
end;
$$;


ALTER FUNCTION public.ensure_paper_shadow_account() OWNER TO postgres;

--
-- Name: ensure_strategy_shadow(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.ensure_strategy_shadow() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.ensure_strategy_shadow() OWNER TO postgres;

--
-- Name: finalize_outbox(uuid, text, text, text, timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.finalize_outbox(p_id uuid, p_state text, p_provider_id text DEFAULT NULL::text, p_error text DEFAULT NULL::text, p_next_attempt_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_attempt integer DEFAULT NULL::integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


ALTER FUNCTION public.finalize_outbox(p_id uuid, p_state text, p_provider_id text, p_error text, p_next_attempt_at timestamp with time zone, p_attempt integer) OWNER TO postgres;

--
-- Name: finish_hyperliquid_account_sync(uuid, boolean, bigint, bigint, bigint, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.finish_hyperliquid_account_sync(p_user_id uuid, p_succeeded boolean, p_fills_cursor_ms bigint DEFAULT NULL::bigint, p_funding_cursor_ms bigint DEFAULT NULL::bigint, p_ledger_cursor_ms bigint DEFAULT NULL::bigint, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


ALTER FUNCTION public.finish_hyperliquid_account_sync(p_user_id uuid, p_succeeded boolean, p_fills_cursor_ms bigint, p_funding_cursor_ms bigint, p_ledger_cursor_ms bigint, p_error text) OWNER TO postgres;

--
-- Name: finish_paper_processor_bucket(timestamp with time zone, text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.finish_paper_processor_bucket(p_bucket timestamp with time zone, p_state text, p_metrics jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if p_state not in ('succeeded', 'partial', 'failed') then
    raise exception 'invalid processor state';
  end if;
  update public.paper_processor_runs set
    state = p_state,
    finished_at = now(),
    lease_until = null,
    assets_processed = coalesce((p_metrics ->> 'assetsProcessed')::integer, assets_processed),
    accounts_processed = coalesce((p_metrics ->> 'accountsProcessed')::integer, accounts_processed),
    api_weight = coalesce((p_metrics ->> 'apiWeight')::integer, api_weight),
    projected_invocations = coalesce((p_metrics ->> 'projectedInvocations')::integer, projected_invocations),
    reconciliation_failures = coalesce((p_metrics ->> 'reconciliationFailures')::integer, reconciliation_failures),
    details = coalesce(p_metrics -> 'details', details)
  where bucket = p_bucket;
  update public.paper_processor_lease set bucket = null, lease_until = null
  where singleton and bucket = p_bucket;
end;
$$;


ALTER FUNCTION public.finish_paper_processor_bucket(p_bucket timestamp with time zone, p_state text, p_metrics jsonb) OWNER TO postgres;

--
-- Name: fixed_alert_delivery(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.fixed_alert_delivery() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.detector = 'fixed_price' then new.delivery := 'both'; end if;
  return new;
end;
$$;


ALTER FUNCTION public.fixed_alert_delivery() OWNER TO postgres;

--
-- Name: guard_migrated_alert_rules(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.guard_migrated_alert_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


ALTER FUNCTION public.guard_migrated_alert_rules() OWNER TO postgres;

--
-- Name: guard_strategy_owned_paper_command(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.guard_strategy_owned_paper_command() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare command_asset text;
begin
  command_asset := new.canonical_result->'order'->>'asset';
  if command_asset is null or new.idempotency_key like 'strategy:%' then return new; end if;
  if exists(
    select 1 from public.strategy_assignments a
    where a.epoch_id=new.epoch_id and a.asset=command_asset and a.state <> 'paused'
  ) then raise exception using errcode='P0001', message='asset is controlled by an enabled strategy; pause it before placing a manual order';
  end if;
  return new;
end $$;


ALTER FUNCTION public.guard_strategy_owned_paper_command() OWNER TO postgres;

--
-- Name: paper_fee_volume(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.paper_fee_volume(p_epoch_id uuid, p_now timestamp with time zone DEFAULT now()) RETURNS TABLE(trailing_volume numeric, maker_volume numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select
    coalesce(sum(abs(f.size * f.price)), 0)::numeric as trailing_volume,
    coalesce(sum(abs(f.size * f.price)) filter (where f.liquidity = 'maker'), 0)::numeric as maker_volume
  from public.paper_fills f
  where f.epoch_id = p_epoch_id
    and f.source_timestamp >= (date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC') - interval '14 days'
    and f.source_timestamp < (date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC')
    and (
      auth.role() = 'service_role'
      or exists (
        select 1
        from public.paper_account_epochs e
        join public.paper_accounts a on a.id = e.account_id
        where e.id = p_epoch_id
          and a.user_id = auth.uid()
          and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'
      )
    );
$$;


ALTER FUNCTION public.paper_fee_volume(p_epoch_id uuid, p_now timestamp with time zone) OWNER TO postgres;

--
-- Name: paper_funding_exposure(uuid, text, timestamp with time zone[]); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.paper_funding_exposure(p_epoch_id uuid, p_asset text, p_timestamps timestamp with time zone[]) RETURNS TABLE(funding_timestamp timestamp with time zone, signed_size numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select
    boundary.funding_timestamp,
    coalesce(sum(case f.side when 'buy' then f.size else -f.size end), 0)::numeric as signed_size
  from unnest(p_timestamps) as boundary(funding_timestamp)
  left join public.paper_fills f
    on f.epoch_id = p_epoch_id
    and f.asset = p_asset
    and f.source_timestamp < boundary.funding_timestamp
  where auth.role() = 'service_role'
  group by boundary.funding_timestamp
  order by boundary.funding_timestamp;
$$;


ALTER FUNCTION public.paper_funding_exposure(p_epoch_id uuid, p_asset text, p_timestamps timestamp with time zone[]) OWNER TO postgres;

--
-- Name: paper_processor_account_state(uuid, text, timestamp with time zone[]); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.paper_processor_account_state(p_epoch_id uuid, p_asset text, p_funding_timestamps timestamp with time zone[]) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;

  select jsonb_build_object(
    'epochVersion', epoch.version,
    'summary', (select jsonb_build_object('cash_balance', summary.cash_balance::text, 'equity', summary.equity::text)
      from public.paper_account_summaries summary where summary.epoch_id = epoch.id),
    'positions', coalesce((select jsonb_agg(jsonb_build_object(
      'asset', position.asset, 'margin_mode', position.margin_mode, 'signed_size', position.signed_size::text,
      'entry_price', position.entry_price::text, 'mark_price', position.mark_price::text,
      'isolated_margin', case when position.isolated_margin is null then null else to_jsonb(position.isolated_margin::text) end
    ) order by position.asset) from public.paper_positions position where position.epoch_id = epoch.id), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
      'id', paper_order.id, 'asset', paper_order.asset, 'side', paper_order.side, 'order_type', paper_order.order_type,
      'time_in_force', paper_order.time_in_force, 'status', paper_order.status,
      'remaining_size', paper_order.remaining_size::text,
      'limit_price', case when paper_order.limit_price is null then null else to_jsonb(paper_order.limit_price::text) end,
      'trigger_price', case when paper_order.trigger_price is null then null else to_jsonb(paper_order.trigger_price::text) end,
      'queue_ahead', case when paper_order.queue_ahead is null then null else to_jsonb(paper_order.queue_ahead::text) end,
      'reduce_only', paper_order.reduce_only, 'leverage', paper_order.leverage,
      'reserved_margin', paper_order.reserved_margin::text, 'created_at', paper_order.created_at
    ) order by paper_order.created_at) from public.paper_orders paper_order
      where paper_order.epoch_id = epoch.id and paper_order.status in ('resting', 'partially_filled', 'trigger_waiting')), '[]'::jsonb),
    'fundingPayments', coalesce((select jsonb_agg(jsonb_build_object('funding_timestamp', payment.funding_timestamp)) from public.paper_funding_payments payment
      where payment.epoch_id = epoch.id and payment.asset = p_asset
        and payment.funding_timestamp = any(coalesce(p_funding_timestamps, '{}'::timestamptz[]))), '[]'::jsonb),
    'fundingExposure', coalesce((select jsonb_agg(jsonb_build_object(
      'funding_timestamp', exposure.funding_timestamp, 'signed_size', exposure.signed_size::text
    ) order by exposure.funding_timestamp)
      from public.paper_funding_exposure(epoch.id, p_asset, coalesce(p_funding_timestamps, '{}'::timestamptz[])) exposure), '[]'::jsonb),
    'leverageSettings', coalesce((select jsonb_agg(jsonb_build_object('asset', setting.asset, 'leverage', setting.leverage) order by setting.asset) from public.paper_leverage_settings setting
      where setting.epoch_id = epoch.id), '[]'::jsonb),
    'cursor', (select jsonb_build_object('last_trade_id', cursor_row.last_trade_id, 'last_timestamp_ms', cursor_row.last_timestamp_ms)
      from public.paper_account_market_cursors cursor_row
      where cursor_row.epoch_id = epoch.id and cursor_row.asset = p_asset)
  ) into result
  from public.paper_account_epochs epoch
  where epoch.id = p_epoch_id and epoch.state = 'active';
  return result;
end;
$$;


ALTER FUNCTION public.paper_processor_account_state(p_epoch_id uuid, p_asset text, p_funding_timestamps timestamp with time zone[]) OWNER TO postgres;

--
-- Name: paper_processor_risk_state(uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.paper_processor_risk_state(p_epoch_id uuid, p_asset text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  select jsonb_build_object(
    'epochVersion', epoch.version,
    'cashBalance', summary.cash_balance::text,
    'positions', coalesce((select jsonb_agg(jsonb_build_object(
      'asset', position.asset, 'margin_mode', position.margin_mode, 'signed_size', position.signed_size::text,
      'entry_price', position.entry_price::text, 'mark_price', position.mark_price::text,
      'isolated_margin', case when position.isolated_margin is null then null else to_jsonb(position.isolated_margin::text) end
    ) order by position.asset) from public.paper_positions position
      where position.epoch_id = epoch.id), '[]'::jsonb),
    'cooldownUntil', (select liquidation.cooldown_until from public.paper_liquidations liquidation
      where liquidation.epoch_id = epoch.id and liquidation.asset = p_asset and liquidation.cooldown_until is not null
      order by liquidation.created_at desc limit 1)
  ) into result
  from public.paper_account_epochs epoch
  join public.paper_account_summaries summary on summary.epoch_id = epoch.id
  where epoch.id = p_epoch_id and epoch.state = 'active';
  return result;
end;
$$;


ALTER FUNCTION public.paper_processor_risk_state(p_epoch_id uuid, p_asset text) OWNER TO postgres;

--
-- Name: prune_listener_history(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.prune_listener_history() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  observation_count integer;
  run_count integer;
  model_count integer;
begin
  delete from public.market_observations where bucket < now() - interval '30 days';
  get diagnostics observation_count = row_count;
  delete from public.monitor_runs where bucket < now() - interval '14 days';
  get diagnostics run_count = row_count;
  delete from public.detector_models where expires_at < now() - interval '30 days';
  get diagnostics model_count = row_count;
  return jsonb_build_object('observations', observation_count, 'runs', run_count, 'models', model_count);
end;
$$;


ALTER FUNCTION public.prune_listener_history() OWNER TO postgres;

--
-- Name: prune_paper_diagnostics(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.prune_paper_diagnostics() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare input_count integer;
declare run_count integer;
begin
  delete from public.paper_market_inputs where created_at < now() - interval '7 days';
  get diagnostics input_count = row_count;
  delete from public.paper_processor_runs where bucket < now() - interval '30 days';
  get diagnostics run_count = row_count;
  return jsonb_build_object('marketInputs', input_count, 'processorRuns', run_count);
end;
$$;


ALTER FUNCTION public.prune_paper_diagnostics() OWNER TO postgres;

--
-- Name: queue_strategy_backtest(uuid, text[], timestamp with time zone, timestamp with time zone, numeric); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.queue_strategy_backtest(p_revision_id uuid, p_assets text[], p_start timestamp with time zone, p_end timestamp with time zone, p_initial_capital numeric DEFAULT 5000) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $_$
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
end $_$;


ALTER FUNCTION public.queue_strategy_backtest(p_revision_id uuid, p_assets text[], p_start timestamp with time zone, p_end timestamp with time zone, p_initial_capital numeric) OWNER TO postgres;

--
-- Name: record_alert_occurrence(uuid, timestamp with time zone, double precision, text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.record_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
 if exists(select 1 from public.alert_runtime_destination where active) then return null; end if;
 return public.record_legacy_alert_occurrence(p_rule_id,p_bucket,p_mark_price,p_classification,p_evidence);
end;
$$;


ALTER FUNCTION public.record_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb) OWNER TO postgres;

--
-- Name: record_asset_price_samples(timestamp with time zone, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.record_asset_price_samples(p_bucket timestamp with time zone, p_samples jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  sample record;
  bucket_ms bigint;
  retention_ms bigint;
  recent_ms bigint;
  day_ms bigint;
  updated_count integer := 0;
  affected_count integer := 0;
begin
  if p_bucket is null or p_samples is null or jsonb_typeof(p_samples) <> 'array' or jsonb_array_length(p_samples) > 1000 then
    raise exception 'Invalid asset price snapshot' using errcode = '22023';
  end if;

  bucket_ms := floor(extract(epoch from p_bucket) * 1000)::bigint;
  retention_ms := bucket_ms - (31::bigint * 24 * 60 * 60 * 1000);
  recent_ms := bucket_ms - (25::bigint * 60 * 60 * 1000);
  day_ms := floor(bucket_ms::numeric / 86400000)::bigint * 86400000;

  for sample in
    select
      value->>'asset' as asset,
      (value->>'price')::numeric as price,
      case
        when value->>'dayVolume' ~ '^[0-9]+(?:\.[0-9]+)?$' then (value->>'dayVolume')::numeric
        else null
      end as day_volume
    from jsonb_array_elements(p_samples)
    where jsonb_typeof(value) = 'object'
      and value->>'asset' ~ '^[a-zA-Z0-9_.:-]+$'
      and value->>'price' ~ '^[0-9]+(?:\.[0-9]+)?$'
      and (value->>'price')::numeric > 0
  loop
    insert into public.asset_analytics_cache as cache (
      asset,
      average_daily_volume,
      price_history,
      history_updated_at,
      daily_volume_history,
      average_volume_updated_at
    ) values (
      sample.asset,
      sample.day_volume,
      jsonb_build_array(jsonb_build_object('time', bucket_ms, 'price', sample.price)),
      p_bucket,
      case when sample.day_volume is null then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object('time', day_ms, 'volume', sample.day_volume)) end,
      case when sample.day_volume is null then null else p_bucket end
    )
    on conflict (asset) do update
    set price_history = (
      select coalesce(
        jsonb_agg(jsonb_build_object('time', retained.time_ms, 'price', retained.price) order by retained.time_ms),
        '[]'::jsonb
      )
      from (
        select distinct on (
          case when history.time_ms < recent_ms then floor(history.time_ms::numeric / 3600000) else history.time_ms end
        ) history.time_ms, history.price
        from (
          select
            (point->>'time')::bigint as time_ms,
            (point->>'price')::numeric as price,
            0 as source_priority
          from jsonb_array_elements(cache.price_history) point
          where jsonb_typeof(point) = 'object'
            and point->>'time' ~ '^[0-9]+$'
            and point->>'price' ~ '^[0-9]+(?:\.[0-9]+)?$'
          union all
          select bucket_ms, sample.price, 1
        ) history
        where history.time_ms between retention_ms and bucket_ms
          and history.price > 0
        order by
          case when history.time_ms < recent_ms then floor(history.time_ms::numeric / 3600000) else history.time_ms end,
          history.time_ms desc,
          history.source_priority desc
      ) retained
    ),
    history_updated_at = p_bucket,
    daily_volume_history = case when sample.day_volume is null then cache.daily_volume_history else (
      select coalesce(
        jsonb_agg(jsonb_build_object('time', volumes.time_ms, 'volume', volumes.volume) order by volumes.time_ms),
        '[]'::jsonb
      )
      from (
        select distinct on (history.time_ms) history.time_ms, history.volume
        from (
          select (point->>'time')::bigint as time_ms, (point->>'volume')::numeric as volume, 0 as source_priority
          from jsonb_array_elements(cache.daily_volume_history) point
          where jsonb_typeof(point) = 'object'
            and point->>'time' ~ '^[0-9]+$'
            and point->>'volume' ~ '^[0-9]+(?:\.[0-9]+)?$'
          union all
          select day_ms, sample.day_volume, 1
        ) history
        where history.time_ms between day_ms - (29::bigint * 86400000) and day_ms
          and history.volume >= 0
        order by history.time_ms, history.source_priority desc
      ) volumes
    ) end,
    average_daily_volume = case
      when sample.day_volume is null then cache.average_daily_volume
      when cache.average_daily_volume is not null and jsonb_array_length(cache.daily_volume_history) < 6
        then cache.average_daily_volume
      else (
        select avg(volumes.volume)::double precision
        from (
          select distinct on (history.time_ms) history.time_ms, history.volume
          from (
            select (point->>'time')::bigint as time_ms, (point->>'volume')::numeric as volume, 0 as source_priority
            from jsonb_array_elements(cache.daily_volume_history) point
            where jsonb_typeof(point) = 'object'
              and point->>'time' ~ '^[0-9]+$'
              and point->>'volume' ~ '^[0-9]+(?:\.[0-9]+)?$'
            union all
            select day_ms, sample.day_volume, 1
          ) history
          where history.time_ms between day_ms - (29::bigint * 86400000) and day_ms
            and history.volume >= 0
          order by history.time_ms, history.source_priority desc
        ) volumes
      )
    end,
    average_volume_updated_at = case when sample.day_volume is null then cache.average_volume_updated_at else p_bucket end
    where cache.history_updated_at is null or cache.history_updated_at <= excluded.history_updated_at;
    get diagnostics affected_count = row_count;
    updated_count := updated_count + affected_count;
  end loop;

  return updated_count;
end;
$_$;


ALTER FUNCTION public.record_asset_price_samples(p_bucket timestamp with time zone, p_samples jsonb) OWNER TO postgres;

--
-- Name: record_legacy_alert_occurrence(uuid, timestamp with time zone, double precision, text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.record_legacy_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


ALTER FUNCTION public.record_legacy_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb) OWNER TO postgres;

--
-- Name: reject_strategy_revision_mutation(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.reject_strategy_revision_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin raise exception 'strategy revisions are immutable'; end $$;


ALTER FUNCTION public.reject_strategy_revision_mutation() OWNER TO postgres;

--
-- Name: rename_paper_account(uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rename_paper_account(p_account_id uuid, p_name text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare changed boolean;
begin
  perform public.require_paper_owner();
  update public.paper_accounts
  set name = trim(p_name)
  where id = p_account_id and user_id = auth.uid() and archived_at is null
  returning true into changed;
  return coalesce(changed, false);
end;
$$;


ALTER FUNCTION public.rename_paper_account(p_account_id uuid, p_name text) OWNER TO postgres;

--
-- Name: replace_hyperliquid_account_positions(uuid, text, timestamp with time zone, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.replace_hyperliquid_account_positions(p_user_id uuid, p_address text, p_observed_at timestamp with time zone, p_positions jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if jsonb_typeof(p_positions) <> 'array' then
    raise exception 'positions must be a JSON array';
  end if;
  if not exists (
    select 1 from public.hyperliquid_account_sources
    where user_id = p_user_id and address = p_address and active
  ) then
    raise exception 'active account source not found';
  end if;

  delete from public.hyperliquid_account_positions
  where user_id = p_user_id and account_address = p_address;

  insert into public.hyperliquid_account_positions (
    user_id, account_address, dex, asset, signed_size, entry_price, position_value,
    unrealized_pnl, margin_used, liquidation_price, leverage_type, leverage, raw, observed_at
  )
  select p_user_id, p_address, position.dex, position.asset, position.signed_size,
    position.entry_price, position.position_value, position.unrealized_pnl, position.margin_used,
    position.liquidation_price, position.leverage_type, position.leverage, position.raw, p_observed_at
  from jsonb_to_recordset(p_positions) as position(
    dex text, asset text, signed_size numeric, entry_price numeric, position_value numeric,
    unrealized_pnl numeric, margin_used numeric, liquidation_price numeric,
    leverage_type text, leverage integer, raw jsonb
  );
end;
$$;


ALTER FUNCTION public.replace_hyperliquid_account_positions(p_user_id uuid, p_address text, p_observed_at timestamp with time zone, p_positions jsonb) OWNER TO postgres;

--
-- Name: require_paper_owner(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.require_paper_owner() RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'auth'
    AS $$
begin
  if auth.uid() is null or auth.jwt() ->> 'email' <> 'jasonblick@zohomail.com' then
    raise exception 'not authorized';
  end if;
  return auth.uid();
end;
$$;


ALTER FUNCTION public.require_paper_owner() OWNER TO postgres;

--
-- Name: reset_paper_account(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.reset_paper_account(p_account_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare
  next_epoch integer;
  old_epoch_id uuid;
  new_epoch_id uuid;
  account_starting_capital numeric(38, 6);
begin
  perform public.require_paper_owner();
  select active_epoch, starting_capital into next_epoch, account_starting_capital
  from public.paper_accounts
  where id = p_account_id and user_id = auth.uid() and archived_at is null
  for update;
  if next_epoch is null then raise exception 'paper account not found'; end if;
  select id into old_epoch_id from public.paper_account_epochs
  where account_id = p_account_id and epoch_number = next_epoch and state = 'active'
  for update;
  update public.paper_orders set status = 'canceled', rejection_reason = 'account reset', updated_at = now()
  where epoch_id = old_epoch_id and status in ('resting', 'trigger_waiting', 'partially_filled');
  update public.paper_account_epochs
  set state = 'closed', closed_at = now(),
      closing_summary = (select to_jsonb(s) from public.paper_account_summaries s where s.epoch_id = old_epoch_id)
  where id = old_epoch_id;
  next_epoch := next_epoch + 1;
  update public.paper_accounts set active_epoch = next_epoch where id = p_account_id;
  insert into public.paper_account_epochs (account_id, epoch_number)
  values (p_account_id, next_epoch) returning id into new_epoch_id;
  insert into public.paper_account_summaries (epoch_id, cash_balance, equity)
  values (new_epoch_id, account_starting_capital, account_starting_capital);
  insert into public.paper_ledger_entries (epoch_id, entry_type, amount)
  values (new_epoch_id, 'opening_balance', account_starting_capital);
  return next_epoch;
end;
$$;


ALTER FUNCTION public.reset_paper_account(p_account_id uuid) OWNER TO postgres;

--
-- Name: revalue_paper_epoch_asset(uuid, bigint, text, numeric, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.revalue_paper_epoch_asset(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_mark_price numeric, p_input_version text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare current_version bigint;
begin
  select version into current_version from public.paper_account_epochs
  where id = p_epoch_id and state = 'active' for update;
  if current_version is null or current_version <> p_expected_version then return false; end if;

  update public.paper_positions set
    mark_price = p_mark_price,
    input_version = p_input_version,
    updated_at = now()
  where epoch_id = p_epoch_id and asset = p_asset;
  if not found then return true; end if;

  update public.paper_account_summaries summary set
    unrealized_pnl = totals.unrealized,
    equity = summary.cash_balance + totals.unrealized,
    total_notional = totals.notional,
    fidelity = 'live',
    reconciled_at = now()
  from (
    select
      coalesce(sum(signed_size * (mark_price - entry_price)), 0)::numeric(38, 6) as unrealized,
      coalesce(sum(abs(signed_size) * mark_price), 0)::numeric(38, 6) as notional
    from public.paper_positions where epoch_id = p_epoch_id
  ) totals
  where summary.epoch_id = p_epoch_id;

  -- Derived marks do not invalidate economic commands. The no-op update still
  -- publishes an epoch UPDATE so browser subscribers refresh persisted state.
  update public.paper_account_epochs set version = version where id = p_epoch_id;
  return true;
end;
$$;


ALTER FUNCTION public.revalue_paper_epoch_asset(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_mark_price numeric, p_input_version text) OWNER TO postgres;

--
-- Name: set_alert_rule_enabled(uuid, boolean); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_alert_rule_enabled(p_rule_id uuid, p_enabled boolean) RETURNS public.alert_rules
    LANGUAGE plpgsql
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.set_alert_rule_enabled(p_rule_id uuid, p_enabled boolean) OWNER TO postgres;

--
-- Name: set_paper_leverage(uuid, text, text, integer, numeric); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_paper_leverage(p_account_id uuid, p_asset text, p_margin_mode text, p_leverage integer, p_isolated_margin numeric DEFAULT NULL::numeric) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
declare target_epoch_id uuid;
declare asset_metadata jsonb;
begin
  perform public.require_paper_owner();
  if p_margin_mode not in ('cross', 'isolated') or p_leverage <= 0 then
    raise exception 'invalid leverage setting';
  end if;
  select e.id into target_epoch_id
  from public.paper_accounts a
  join public.paper_account_epochs e on e.account_id = a.id and e.epoch_number = a.active_epoch
  where a.id = p_account_id and a.user_id = auth.uid() and a.archived_at is null and e.state = 'active'
  for update of e;
  if target_epoch_id is null then raise exception 'paper account not found'; end if;
  select candidate.asset into asset_metadata
  from public.paper_market_inputs input
  cross join lateral jsonb_array_elements(input.payload -> 'assets') candidate(asset)
  where input.asset = '*' and input.input_kind = 'metadata'
    and candidate.asset ->> 'asset' = p_asset
  order by input.created_at desc
  limit 1;
  if asset_metadata is null then raise exception 'paper asset metadata unavailable'; end if;
  if p_leverage > (asset_metadata ->> 'maxLeverage')::integer then
    raise exception 'asset leverage exceeds market maximum';
  end if;
  if coalesce((asset_metadata ->> 'onlyIsolated')::boolean, false) and p_margin_mode <> 'isolated' then
    raise exception 'asset requires isolated margin';
  end if;
  insert into public.paper_leverage_settings (epoch_id, asset, margin_mode, leverage, isolated_margin)
  values (target_epoch_id, p_asset, p_margin_mode, p_leverage, p_isolated_margin)
  on conflict (epoch_id, asset) do update set
    margin_mode = excluded.margin_mode,
    leverage = excluded.leverage,
    isolated_margin = excluded.isolated_margin,
    updated_at = now();
  return true;
end;
$$;


ALTER FUNCTION public.set_paper_leverage(p_account_id uuid, p_asset text, p_margin_mode text, p_leverage integer, p_isolated_margin numeric) OWNER TO postgres;

--
-- Name: set_paper_risk_projection(uuid, bigint, numeric, numeric); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_paper_risk_projection(p_epoch_id uuid, p_expected_version bigint, p_margin_used numeric, p_maintenance_margin numeric) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare current_version bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  select version into current_version from public.paper_account_epochs
  where id = p_epoch_id and state = 'active' for update;
  if current_version is null or current_version <> p_expected_version then return false; end if;
  update public.paper_account_summaries set
    margin_used = p_margin_used,
    maintenance_margin = p_maintenance_margin
  where epoch_id = p_epoch_id;
  return found;
end;
$$;


ALTER FUNCTION public.set_paper_risk_projection(p_epoch_id uuid, p_expected_version bigint, p_margin_used numeric, p_maintenance_margin numeric) OWNER TO postgres;

--
-- Name: set_strategy_assignment_state(uuid, text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_strategy_assignment_state(p_assignment_id uuid, p_state text, p_pause_mode text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
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


ALTER FUNCTION public.set_strategy_assignment_state(p_assignment_id uuid, p_state text, p_pause_mode text) OWNER TO postgres;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION public.set_updated_at() OWNER TO postgres;

--
-- Name: validate_trade_log_share_balance(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.validate_trade_log_share_balance() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  target_user_id uuid := coalesce(new.user_id, old.user_id);
  target_asset text := coalesce(new.asset, old.asset);
  minimum_balance numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':' || target_asset, 0));

  select min(balance)
  into minimum_balance
  from (
    select sum(case when side = 'buy' then shares else -shares end) over (
      order by executed_at, created_at, id
      rows between unbounded preceding and current row
    ) as balance
    from public.trade_log_orders
    where user_id = target_user_id and asset = target_asset
  ) chronological_balances;

  if coalesce(minimum_balance, 0) < 0 then
    raise exception 'Trade would make the chronological share balance negative for %', target_asset;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;


ALTER FUNCTION public.validate_trade_log_share_balance() OWNER TO postgres;

--
-- Name: alert_occurrences; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.alert_occurrences (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    user_id uuid NOT NULL,
    bucket timestamp with time zone NOT NULL,
    asset text NOT NULL,
    detector text NOT NULL,
    mark_price double precision NOT NULL,
    classification text DEFAULT 'uncertain'::text NOT NULL,
    evidence jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alert_occurrences_classification_check CHECK ((classification = ANY (ARRAY['fixed_price'::text, 'underlying_move'::text, 'venue_dislocation'::text, 'uncertain'::text]))),
    CONSTRAINT alert_occurrences_mark_price_check CHECK (((mark_price > (0)::double precision) AND (mark_price < 'Infinity'::double precision)))
);


ALTER TABLE public.alert_occurrences OWNER TO postgres;

--
-- Name: alert_runtime_destination; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.alert_runtime_destination (
    id boolean DEFAULT true NOT NULL,
    active boolean DEFAULT false NOT NULL,
    origin text DEFAULT ''::text NOT NULL,
    CONSTRAINT alert_runtime_destination_id_check CHECK (id)
);


ALTER TABLE public.alert_runtime_destination OWNER TO postgres;

--
-- Name: asset_analytics_cache; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.asset_analytics_cache (
    asset text NOT NULL,
    average_daily_volume double precision,
    price_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    history_updated_at timestamp with time zone,
    average_volume_updated_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    daily_volume_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT asset_analytics_cache_asset_check CHECK ((asset ~ '^[a-zA-Z0-9_.:-]+$'::text)),
    CONSTRAINT asset_analytics_cache_average_daily_volume_check CHECK (((average_daily_volume IS NULL) OR ((average_daily_volume >= (0)::double precision) AND (average_daily_volume < 'Infinity'::double precision)))),
    CONSTRAINT asset_analytics_cache_daily_volume_history_check CHECK ((jsonb_typeof(daily_volume_history) = 'array'::text)),
    CONSTRAINT asset_analytics_cache_price_history_check CHECK ((jsonb_typeof(price_history) = 'array'::text))
);


ALTER TABLE public.asset_analytics_cache OWNER TO postgres;

--
-- Name: audio_listener_assets; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audio_listener_assets (
    user_id uuid NOT NULL,
    asset text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audio_listener_assets_asset_check CHECK (((char_length(asset) >= 1) AND (char_length(asset) <= 80)))
);


ALTER TABLE public.audio_listener_assets OWNER TO postgres;

--
-- Name: backtest_equity_points; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.backtest_equity_points (
    run_id uuid NOT NULL,
    sampled_at timestamp with time zone NOT NULL,
    equity numeric(38,6) NOT NULL,
    reason text NOT NULL,
    CONSTRAINT backtest_equity_points_reason_check CHECK ((reason = ANY (ARRAY['hourly'::text, 'entry'::text, 'exit'::text, 'start'::text, 'end'::text])))
);


ALTER TABLE public.backtest_equity_points OWNER TO postgres;

--
-- Name: backtest_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.backtest_runs (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    assets text[] NOT NULL,
    requested_start timestamp with time zone NOT NULL,
    requested_end timestamp with time zone NOT NULL,
    actual_start timestamp with time zone,
    actual_end timestamp with time zone,
    initial_capital numeric(38,6) DEFAULT 5000 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    work_cursor jsonb DEFAULT '{}'::jsonb NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    assumptions jsonb DEFAULT '{}'::jsonb NOT NULL,
    fidelity jsonb DEFAULT '{"signal": "exact", "execution": "bar_conservative", "constraints": "current_constraints"}'::jsonb NOT NULL,
    metrics jsonb,
    result_hash text,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT backtest_runs_assets_check CHECK (((cardinality(assets) >= 1) AND (cardinality(assets) <= 20))),
    CONSTRAINT backtest_runs_check CHECK ((requested_end > requested_start)),
    CONSTRAINT backtest_runs_initial_capital_check CHECK ((initial_capital > (0)::numeric)),
    CONSTRAINT backtest_runs_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT backtest_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'degraded'::text, 'failed'::text])))
);


ALTER TABLE public.backtest_runs OWNER TO postgres;

--
-- Name: backtest_trades; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.backtest_trades (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    asset text NOT NULL,
    side text NOT NULL,
    entry_time timestamp with time zone NOT NULL,
    entry_price numeric(38,12) NOT NULL,
    exit_time timestamp with time zone NOT NULL,
    exit_price numeric(38,12) NOT NULL,
    initial_margin numeric(38,6) NOT NULL,
    gross_pnl numeric(38,6) NOT NULL,
    fees numeric(38,6) NOT NULL,
    funding numeric(38,6) NOT NULL,
    net_pnl numeric(38,6) NOT NULL,
    exit_reason text NOT NULL,
    fidelity jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scope text DEFAULT 'asset'::text NOT NULL,
    CONSTRAINT backtest_trades_scope_check CHECK ((scope = ANY (ARRAY['asset'::text, 'portfolio'::text]))),
    CONSTRAINT backtest_trades_side_check CHECK ((side = ANY (ARRAY['long'::text, 'short'::text])))
);


ALTER TABLE public.backtest_trades OWNER TO postgres;

--
-- Name: detector_models; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.detector_models (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    asset text NOT NULL,
    horizon_minutes integer NOT NULL,
    detector text DEFAULT 'large_move'::text NOT NULL,
    model_version text NOT NULL,
    source text NOT NULL,
    parameters jsonb NOT NULL,
    sample_count integer NOT NULL,
    coverage_start timestamp with time zone,
    coverage_end timestamp with time zone,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT detector_models_horizon_minutes_check CHECK (((horizon_minutes >= 1) AND (horizon_minutes <= 10080))),
    CONSTRAINT detector_models_sample_count_check CHECK ((sample_count >= 0)),
    CONSTRAINT detector_models_source_check CHECK ((source = ANY (ARRAY['trade_candle_bootstrap'::text, 'mark_history'::text])))
);


ALTER TABLE public.detector_models OWNER TO postgres;

--
-- Name: hyperliquid_account_fills; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hyperliquid_account_fills (
    user_id uuid NOT NULL,
    account_address text NOT NULL,
    trade_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    occurred_at_ms bigint NOT NULL,
    asset text NOT NULL,
    side text NOT NULL,
    direction text NOT NULL,
    price numeric(38,12) NOT NULL,
    size numeric(38,12) NOT NULL,
    start_position numeric(38,12),
    closed_pnl numeric(38,12) DEFAULT 0 NOT NULL,
    fee numeric(38,12) DEFAULT 0 NOT NULL,
    fee_token text,
    crossed boolean,
    order_id text NOT NULL,
    transaction_hash text,
    twap_id text,
    raw jsonb NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hyperliquid_account_fills_account_address_check CHECK ((account_address ~ '^0x[a-f0-9]{40}$'::text)),
    CONSTRAINT hyperliquid_account_fills_occurred_at_ms_check CHECK ((occurred_at_ms >= 0)),
    CONSTRAINT hyperliquid_account_fills_price_check CHECK ((price > (0)::numeric)),
    CONSTRAINT hyperliquid_account_fills_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text]))),
    CONSTRAINT hyperliquid_account_fills_size_check CHECK ((size > (0)::numeric))
);


ALTER TABLE public.hyperliquid_account_fills OWNER TO postgres;

--
-- Name: hyperliquid_account_funding; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hyperliquid_account_funding (
    user_id uuid NOT NULL,
    account_address text NOT NULL,
    event_key text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    occurred_at_ms bigint NOT NULL,
    asset text NOT NULL,
    funding_rate numeric(38,18),
    position_size numeric(38,12),
    usdc numeric(38,12),
    transaction_hash text,
    raw jsonb NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hyperliquid_account_funding_occurred_at_ms_check CHECK ((occurred_at_ms >= 0))
);


ALTER TABLE public.hyperliquid_account_funding OWNER TO postgres;

--
-- Name: hyperliquid_account_ledger; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hyperliquid_account_ledger (
    user_id uuid NOT NULL,
    account_address text NOT NULL,
    event_key text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    occurred_at_ms bigint NOT NULL,
    event_type text NOT NULL,
    transaction_hash text,
    raw jsonb NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hyperliquid_account_ledger_occurred_at_ms_check CHECK ((occurred_at_ms >= 0))
);


ALTER TABLE public.hyperliquid_account_ledger OWNER TO postgres;

--
-- Name: hyperliquid_account_position_tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hyperliquid_account_position_tags (
    user_id uuid NOT NULL,
    account_address text NOT NULL,
    position_key text NOT NULL,
    asset text NOT NULL,
    direction text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hyperliquid_account_position_tags_account_address_check CHECK ((account_address ~ '^0x[a-f0-9]{40}$'::text)),
    CONSTRAINT hyperliquid_account_position_tags_asset_check CHECK (((length(asset) >= 1) AND (length(asset) <= 100))),
    CONSTRAINT hyperliquid_account_position_tags_direction_check CHECK ((direction = ANY (ARRAY['long'::text, 'short'::text]))),
    CONSTRAINT hyperliquid_account_position_tags_position_key_check CHECK (((length(position_key) >= 1) AND (length(position_key) <= 300))),
    CONSTRAINT hyperliquid_account_position_tags_tags_check CHECK (((cardinality(tags) <= 3) AND (tags <@ ARRAY['EARNINGS'::text, 'MEANREV'::text, 'YOLO'::text])))
);


ALTER TABLE public.hyperliquid_account_position_tags OWNER TO postgres;

--
-- Name: hyperliquid_account_positions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hyperliquid_account_positions (
    user_id uuid NOT NULL,
    account_address text NOT NULL,
    dex text NOT NULL,
    asset text NOT NULL,
    signed_size numeric(38,12) NOT NULL,
    entry_price numeric(38,12),
    position_value numeric(38,12),
    unrealized_pnl numeric(38,12),
    margin_used numeric(38,12),
    liquidation_price numeric(38,12),
    leverage_type text,
    leverage integer,
    raw jsonb NOT NULL,
    observed_at timestamp with time zone NOT NULL
);


ALTER TABLE public.hyperliquid_account_positions OWNER TO postgres;

--
-- Name: hyperliquid_account_sources; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.hyperliquid_account_sources (
    user_id uuid NOT NULL,
    address text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    fills_cursor_ms bigint,
    funding_cursor_ms bigint,
    ledger_cursor_ms bigint,
    lease_until timestamp with time zone,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hyperliquid_account_sources_address_check CHECK ((address ~ '^0x[a-f0-9]{40}$'::text))
);


ALTER TABLE public.hyperliquid_account_sources OWNER TO postgres;

--
-- Name: level_tool_preferences; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.level_tool_preferences (
    user_id uuid NOT NULL,
    asset text NOT NULL,
    risk_dollars numeric DEFAULT 500 NOT NULL,
    session_mode text DEFAULT 'auto'::text NOT NULL,
    visible_level_count integer DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT level_tool_preferences_asset_check CHECK (((length(asset) >= 1) AND (length(asset) <= 100))),
    CONSTRAINT level_tool_preferences_risk_dollars_check CHECK (((risk_dollars >= (0)::numeric) AND (risk_dollars <= (1000000000)::numeric))),
    CONSTRAINT level_tool_preferences_session_mode_check CHECK ((session_mode = ANY (ARRAY['auto'::text, 'new_york_rth'::text, 'utc'::text]))),
    CONSTRAINT level_tool_preferences_visible_level_count_check CHECK (((visible_level_count >= 5) AND (visible_level_count <= 20)))
);


ALTER TABLE public.level_tool_preferences OWNER TO postgres;

--
-- Name: market_observations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.market_observations (
    asset text NOT NULL,
    dex text DEFAULT ''::text NOT NULL,
    bucket timestamp with time zone NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    mark_price double precision NOT NULL,
    oracle_price double precision,
    mid_price double precision,
    open_interest double precision,
    day_volume double precision,
    CONSTRAINT market_observations_day_volume_check CHECK (((day_volume >= (0)::double precision) AND (day_volume < 'Infinity'::double precision))),
    CONSTRAINT market_observations_mark_price_check CHECK (((mark_price > (0)::double precision) AND (mark_price < 'Infinity'::double precision))),
    CONSTRAINT market_observations_mid_price_check CHECK (((mid_price > (0)::double precision) AND (mid_price < 'Infinity'::double precision))),
    CONSTRAINT market_observations_open_interest_check CHECK (((open_interest >= (0)::double precision) AND (open_interest < 'Infinity'::double precision))),
    CONSTRAINT market_observations_oracle_price_check CHECK (((oracle_price > (0)::double precision) AND (oracle_price < 'Infinity'::double precision)))
);


ALTER TABLE public.market_observations OWNER TO postgres;

--
-- Name: monitor_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.monitor_runs (
    bucket timestamp with time zone NOT NULL,
    state text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    lease_until timestamp with time zone,
    assets_checked integer DEFAULT 0 NOT NULL,
    rules_checked integer DEFAULT 0 NOT NULL,
    occurrences_created integer DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT monitor_runs_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'succeeded'::text, 'partial'::text, 'failed'::text])))
);


ALTER TABLE public.monitor_runs OWNER TO postgres;

--
-- Name: new_asset_acknowledgements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.new_asset_acknowledgements (
    user_id uuid NOT NULL,
    asset text NOT NULL,
    acknowledged_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT new_asset_acknowledgements_asset_check CHECK ((char_length(asset) > 0))
);


ALTER TABLE public.new_asset_acknowledgements OWNER TO postgres;

--
-- Name: paper_account_epochs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_account_epochs (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    epoch_number integer NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    opening_balance numeric(38,6) DEFAULT 5000.000000 NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    closing_summary jsonb,
    CONSTRAINT paper_account_epochs_epoch_number_check CHECK ((epoch_number > 0)),
    CONSTRAINT paper_account_epochs_opening_balance_check CHECK ((opening_balance = 5000.000000)),
    CONSTRAINT paper_account_epochs_state_check CHECK ((state = ANY (ARRAY['active'::text, 'closed'::text]))),
    CONSTRAINT paper_account_epochs_version_check CHECK ((version >= 0))
);


ALTER TABLE public.paper_account_epochs OWNER TO postgres;

--
-- Name: paper_account_market_cursors; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_account_market_cursors (
    epoch_id uuid NOT NULL,
    asset text NOT NULL,
    last_trade_id text,
    last_timestamp_ms bigint,
    input_version text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.paper_account_market_cursors OWNER TO postgres;

--
-- Name: paper_account_summaries; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_account_summaries (
    epoch_id uuid NOT NULL,
    cash_balance numeric(38,6) DEFAULT 5000.000000 NOT NULL,
    equity numeric(38,6) DEFAULT 5000.000000 NOT NULL,
    withdrawable numeric(38,6) DEFAULT 5000.000000 NOT NULL,
    margin_used numeric(38,6) DEFAULT 0 NOT NULL,
    maintenance_margin numeric(38,6) DEFAULT 0 NOT NULL,
    total_notional numeric(38,6) DEFAULT 0 NOT NULL,
    unrealized_pnl numeric(38,6) DEFAULT 0 NOT NULL,
    realized_pnl numeric(38,6) DEFAULT 0 NOT NULL,
    cumulative_funding numeric(38,6) DEFAULT 0 NOT NULL,
    cumulative_fees numeric(38,6) DEFAULT 0 NOT NULL,
    trailing_volume numeric(38,6) DEFAULT 0 NOT NULL,
    maker_volume numeric(38,6) DEFAULT 0 NOT NULL,
    fidelity text DEFAULT 'reconciled'::text NOT NULL,
    reconciled_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_account_summaries_fidelity_check CHECK ((fidelity = ANY (ARRAY['reconciled'::text, 'live'::text, 'degraded'::text]))),
    CONSTRAINT paper_account_summaries_maintenance_margin_check CHECK ((maintenance_margin >= (0)::numeric)),
    CONSTRAINT paper_account_summaries_maker_volume_check CHECK ((maker_volume >= (0)::numeric)),
    CONSTRAINT paper_account_summaries_margin_used_check CHECK ((margin_used >= (0)::numeric)),
    CONSTRAINT paper_account_summaries_total_notional_check CHECK ((total_notional >= (0)::numeric)),
    CONSTRAINT paper_account_summaries_trailing_volume_check CHECK ((trailing_volume >= (0)::numeric))
);


ALTER TABLE public.paper_account_summaries OWNER TO postgres;

--
-- Name: paper_accounts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_accounts (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    active_epoch integer DEFAULT 1 NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    starting_capital numeric(38,6) DEFAULT 5000.000000 NOT NULL,
    CONSTRAINT paper_accounts_active_epoch_check CHECK ((active_epoch > 0)),
    CONSTRAINT paper_accounts_name_check CHECK (((char_length(TRIM(BOTH FROM name)) >= 1) AND (char_length(TRIM(BOTH FROM name)) <= 60))),
    CONSTRAINT paper_accounts_starting_capital_check CHECK (((starting_capital > (0)::numeric) AND (starting_capital <= (1000000000)::numeric)))
);


ALTER TABLE public.paper_accounts OWNER TO postgres;

--
-- Name: paper_commands; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_commands (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    epoch_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    expected_version bigint NOT NULL,
    canonical_result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_commands_expected_version_check CHECK ((expected_version >= 0)),
    CONSTRAINT paper_commands_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 128)))
);


ALTER TABLE public.paper_commands OWNER TO postgres;

--
-- Name: paper_fills; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_fills (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    epoch_id uuid NOT NULL,
    order_id uuid,
    asset text NOT NULL,
    side text NOT NULL,
    liquidity text NOT NULL,
    size numeric(38,12) NOT NULL,
    price numeric(38,12) NOT NULL,
    fee numeric(38,6) NOT NULL,
    source_id text NOT NULL,
    source_timestamp timestamp with time zone NOT NULL,
    input_version text NOT NULL,
    fidelity text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_fills_liquidity_check CHECK ((liquidity = ANY (ARRAY['maker'::text, 'taker'::text, 'liquidation'::text]))),
    CONSTRAINT paper_fills_price_check CHECK ((price > (0)::numeric)),
    CONSTRAINT paper_fills_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text]))),
    CONSTRAINT paper_fills_size_check CHECK ((size > (0)::numeric))
);


ALTER TABLE public.paper_fills OWNER TO postgres;

--
-- Name: paper_funding_payments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_funding_payments (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    epoch_id uuid NOT NULL,
    asset text NOT NULL,
    funding_timestamp timestamp with time zone NOT NULL,
    signed_size numeric(38,12) NOT NULL,
    oracle_price numeric(38,12) NOT NULL,
    funding_rate numeric(38,18) NOT NULL,
    payment numeric(38,6) NOT NULL,
    input_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_funding_payments_oracle_price_check CHECK ((oracle_price > (0)::numeric))
);


ALTER TABLE public.paper_funding_payments OWNER TO postgres;

--
-- Name: paper_ledger_entries; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_ledger_entries (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    epoch_id uuid NOT NULL,
    entry_type text NOT NULL,
    amount numeric(38,6) NOT NULL,
    asset text,
    reference_id uuid,
    source_timestamp timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_ledger_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['opening_balance'::text, 'realized_pnl'::text, 'fee'::text, 'funding'::text, 'isolated_transfer'::text, 'liquidation'::text, 'reset_close'::text])))
);


ALTER TABLE public.paper_ledger_entries OWNER TO postgres;

--
-- Name: paper_orders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_orders (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    epoch_id uuid NOT NULL,
    client_order_id text NOT NULL,
    asset text NOT NULL,
    side text NOT NULL,
    order_type text NOT NULL,
    time_in_force text,
    margin_mode text NOT NULL,
    leverage integer NOT NULL,
    size numeric(38,12) NOT NULL,
    remaining_size numeric(38,12) NOT NULL,
    limit_price numeric(38,12),
    trigger_price numeric(38,12),
    reduce_only boolean DEFAULT false NOT NULL,
    status text NOT NULL,
    parent_order_id uuid,
    queue_ahead numeric(38,12),
    reserved_margin numeric(38,6) DEFAULT 0 NOT NULL,
    rejection_reason text,
    fidelity text NOT NULL,
    source_timestamp timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_orders_asset_check CHECK ((asset ~ '^[a-zA-Z0-9_.:-]+$'::text)),
    CONSTRAINT paper_orders_check CHECK (((remaining_size >= (0)::numeric) AND (remaining_size <= size))),
    CONSTRAINT paper_orders_leverage_check CHECK ((leverage > 0)),
    CONSTRAINT paper_orders_limit_price_check CHECK (((limit_price IS NULL) OR (limit_price > (0)::numeric))),
    CONSTRAINT paper_orders_margin_mode_check CHECK ((margin_mode = ANY (ARRAY['cross'::text, 'isolated'::text]))),
    CONSTRAINT paper_orders_order_type_check CHECK ((order_type = ANY (ARRAY['market'::text, 'limit'::text, 'stop_market'::text, 'stop_limit'::text, 'take_market'::text, 'take_limit'::text]))),
    CONSTRAINT paper_orders_queue_ahead_check CHECK (((queue_ahead IS NULL) OR (queue_ahead >= (0)::numeric))),
    CONSTRAINT paper_orders_reserved_margin_check CHECK ((reserved_margin >= (0)::numeric)),
    CONSTRAINT paper_orders_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text]))),
    CONSTRAINT paper_orders_size_check CHECK ((size > (0)::numeric)),
    CONSTRAINT paper_orders_status_check CHECK ((status = ANY (ARRAY['resting'::text, 'trigger_waiting'::text, 'partially_filled'::text, 'filled'::text, 'canceled'::text, 'rejected'::text]))),
    CONSTRAINT paper_orders_time_in_force_check CHECK (((time_in_force IS NULL) OR (time_in_force = ANY (ARRAY['GTC'::text, 'ALO'::text, 'IOC'::text])))),
    CONSTRAINT paper_orders_trigger_price_check CHECK (((trigger_price IS NULL) OR (trigger_price > (0)::numeric)))
);


ALTER TABLE public.paper_orders OWNER TO postgres;

--
-- Name: paper_ledger_history; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.paper_ledger_history WITH (security_invoker='true') AS
 SELECT ledger.id,
    ledger.epoch_id,
    ledger.entry_type,
    ledger.amount,
    ledger.asset,
    ledger.reference_id,
    ledger.source_timestamp,
    ledger.created_at,
    COALESCE(ledger.source_timestamp, ledger.created_at) AS event_at,
    (
        CASE
            WHEN (ledger.asset IS NULL) THEN NULL::numeric
            WHEN (ledger.entry_type = 'funding'::text) THEN funding.oracle_price
            ELSE fills.execution_price
        END)::numeric(38,12) AS asset_price
   FROM ((public.paper_ledger_entries ledger
     LEFT JOIN LATERAL ( SELECT payment.oracle_price
           FROM public.paper_funding_payments payment
          WHERE ((payment.id = ledger.reference_id) AND (payment.epoch_id = ledger.epoch_id) AND (payment.asset = ledger.asset))
         LIMIT 1) funding ON ((ledger.entry_type = 'funding'::text)))
     LEFT JOIN LATERAL ( SELECT (sum((fill.size * fill.price)) / NULLIF(sum(fill.size), (0)::numeric)) AS execution_price
           FROM public.paper_fills fill
          WHERE ((fill.epoch_id = ledger.epoch_id) AND (fill.asset = ledger.asset) AND (fill.source_timestamp = ledger.source_timestamp) AND ((fill.order_id = ledger.reference_id) OR ((NOT (EXISTS ( SELECT 1
                   FROM public.paper_orders referenced_order
                  WHERE ((referenced_order.id = ledger.reference_id) AND (referenced_order.epoch_id = ledger.epoch_id))))) AND (fill.created_at = ( SELECT nearest_fill.created_at
                   FROM public.paper_fills nearest_fill
                  WHERE ((nearest_fill.epoch_id = ledger.epoch_id) AND (nearest_fill.asset = ledger.asset) AND (nearest_fill.source_timestamp = ledger.source_timestamp))
                  ORDER BY (abs(EXTRACT(epoch FROM (nearest_fill.created_at - ledger.created_at))))
                 LIMIT 1)))))) fills ON (((ledger.entry_type <> 'funding'::text) AND (ledger.asset IS NOT NULL))));


ALTER VIEW public.paper_ledger_history OWNER TO postgres;

--
-- Name: VIEW paper_ledger_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.paper_ledger_history IS 'Owner-scoped paper ledger history with source event time and event price: execution VWAP for fill-derived entries and oracle price for funding.';


--
-- Name: paper_leverage_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_leverage_settings (
    epoch_id uuid NOT NULL,
    asset text NOT NULL,
    margin_mode text DEFAULT 'cross'::text NOT NULL,
    leverage integer NOT NULL,
    isolated_margin numeric(38,6),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_leverage_settings_asset_check CHECK ((asset ~ '^[a-zA-Z0-9_.:-]+$'::text)),
    CONSTRAINT paper_leverage_settings_isolated_margin_check CHECK (((isolated_margin IS NULL) OR (isolated_margin >= (0)::numeric))),
    CONSTRAINT paper_leverage_settings_leverage_check CHECK ((leverage > 0)),
    CONSTRAINT paper_leverage_settings_margin_mode_check CHECK ((margin_mode = ANY (ARRAY['cross'::text, 'isolated'::text])))
);


ALTER TABLE public.paper_leverage_settings OWNER TO postgres;

--
-- Name: paper_liquidations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_liquidations (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    epoch_id uuid NOT NULL,
    asset text,
    classification text NOT NULL,
    trigger_snapshot jsonb NOT NULL,
    attempted_fills jsonb DEFAULT '[]'::jsonb NOT NULL,
    maintenance_margin numeric(38,6) NOT NULL,
    remaining_equity numeric(38,6) NOT NULL,
    cooldown_until timestamp with time zone,
    source_timestamp timestamp with time zone NOT NULL,
    input_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_liquidations_classification_check CHECK ((classification = ANY (ARRAY['partial'::text, 'book'::text, 'backstop'::text]))),
    CONSTRAINT paper_liquidations_maintenance_margin_check CHECK ((maintenance_margin >= (0)::numeric))
);


ALTER TABLE public.paper_liquidations OWNER TO postgres;

--
-- Name: paper_market_inputs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_market_inputs (
    asset text NOT NULL,
    input_kind text NOT NULL,
    input_version text NOT NULL,
    source_timestamp timestamp with time zone NOT NULL,
    payload jsonb NOT NULL,
    fidelity text NOT NULL,
    gap_state text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_market_inputs_input_kind_check CHECK ((input_kind = ANY (ARRAY['metadata'::text, 'context'::text, 'book'::text, 'trades'::text, 'funding'::text, 'fees'::text])))
);


ALTER TABLE public.paper_market_inputs OWNER TO postgres;

--
-- Name: paper_order_history; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.paper_order_history WITH (security_invoker='true') AS
 WITH fill_totals AS (
         SELECT fill.epoch_id,
            fill.order_id,
            (sum(fill.size))::numeric(38,12) AS filled_size,
            ((sum((fill.size * fill.price)) / NULLIF(sum(fill.size), (0)::numeric)))::numeric(38,12) AS entry_price,
            (sum((fill.size * fill.price)))::numeric(38,12) AS notional,
            (sum(fill.fee))::numeric(38,6) AS fees
           FROM public.paper_fills fill
          WHERE (fill.order_id IS NOT NULL)
          GROUP BY fill.epoch_id, fill.order_id
        )
 SELECT orders.id,
    orders.epoch_id,
    orders.asset,
    orders.side,
    orders.order_type,
    orders.time_in_force,
    orders.margin_mode,
    orders.leverage,
    orders.size AS requested_size,
    orders.remaining_size,
    orders.limit_price,
    orders.trigger_price,
    orders.reduce_only,
    orders.status,
    orders.rejection_reason,
    orders.fidelity,
    orders.source_timestamp,
    orders.created_at,
    orders.updated_at,
    COALESCE(orders.source_timestamp, orders.created_at) AS event_at,
    fills.filled_size,
    fills.entry_price,
    fills.notional,
    fills.fees
   FROM (public.paper_orders orders
     LEFT JOIN fill_totals fills ON (((fills.order_id = orders.id) AND (fills.epoch_id = orders.epoch_id))));


ALTER VIEW public.paper_order_history OWNER TO postgres;

--
-- Name: VIEW paper_order_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.paper_order_history IS 'Owner-scoped paper order history with requested and filled size, execution VWAP, notional, and fees.';


--
-- Name: paper_positions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_positions (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    epoch_id uuid NOT NULL,
    asset text NOT NULL,
    margin_mode text NOT NULL,
    signed_size numeric(38,12) NOT NULL,
    entry_price numeric(38,12) NOT NULL,
    mark_price numeric(38,12) NOT NULL,
    isolated_margin numeric(38,6),
    realized_pnl numeric(38,6) DEFAULT 0 NOT NULL,
    cumulative_funding numeric(38,6) DEFAULT 0 NOT NULL,
    input_version text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paper_positions_asset_check CHECK ((asset ~ '^[a-zA-Z0-9_.:-]+$'::text)),
    CONSTRAINT paper_positions_entry_price_check CHECK ((entry_price > (0)::numeric)),
    CONSTRAINT paper_positions_isolated_margin_check CHECK (((isolated_margin IS NULL) OR (isolated_margin >= (0)::numeric))),
    CONSTRAINT paper_positions_margin_mode_check CHECK ((margin_mode = ANY (ARRAY['cross'::text, 'isolated'::text]))),
    CONSTRAINT paper_positions_mark_price_check CHECK ((mark_price > (0)::numeric)),
    CONSTRAINT paper_positions_signed_size_check CHECK ((signed_size <> (0)::numeric))
);


ALTER TABLE public.paper_positions OWNER TO postgres;

--
-- Name: paper_processor_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_processor_runs (
    bucket timestamp with time zone NOT NULL,
    state text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    lease_until timestamp with time zone,
    assets_processed integer DEFAULT 0 NOT NULL,
    accounts_processed integer DEFAULT 0 NOT NULL,
    api_weight integer DEFAULT 0 NOT NULL,
    projected_invocations integer,
    lag_seconds integer,
    reconciliation_failures integer DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT paper_processor_runs_accounts_processed_check CHECK ((accounts_processed >= 0)),
    CONSTRAINT paper_processor_runs_api_weight_check CHECK ((api_weight >= 0)),
    CONSTRAINT paper_processor_runs_assets_processed_check CHECK ((assets_processed >= 0)),
    CONSTRAINT paper_processor_runs_reconciliation_failures_check CHECK ((reconciliation_failures >= 0)),
    CONSTRAINT paper_processor_runs_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'succeeded'::text, 'partial'::text, 'failed'::text, 'overlap'::text])))
);


ALTER TABLE public.paper_processor_runs OWNER TO postgres;

--
-- Name: paper_processor_health; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.paper_processor_health WITH (security_invoker='true') AS
 SELECT max(bucket) AS latest_bucket,
    max(finished_at) AS latest_finished_at,
    count(*) FILTER (WHERE (bucket >= (now() - '01:00:00'::interval))) AS runs_last_hour,
    count(*) FILTER (WHERE ((bucket >= (now() - '01:00:00'::interval)) AND (state = ANY (ARRAY['failed'::text, 'partial'::text, 'overlap'::text])))) AS unhealthy_last_hour,
    max(lag_seconds) FILTER (WHERE (bucket >= (now() - '01:00:00'::interval))) AS max_lag_seconds,
    sum(api_weight) FILTER (WHERE (bucket >= (now() - '01:00:00'::interval))) AS api_weight_last_hour,
    max(projected_invocations) AS projected_monthly_invocations,
    sum(reconciliation_failures) FILTER (WHERE (bucket >= (now() - '24:00:00'::interval))) AS reconciliation_failures_24h,
    (array_agg(state ORDER BY bucket DESC))[1] AS latest_state
   FROM public.paper_processor_runs;


ALTER VIEW public.paper_processor_health OWNER TO postgres;

--
-- Name: paper_processor_lease; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_processor_lease (
    singleton boolean DEFAULT true NOT NULL,
    bucket timestamp with time zone,
    lease_until timestamp with time zone,
    CONSTRAINT paper_processor_lease_singleton_check CHECK (singleton)
);


ALTER TABLE public.paper_processor_lease OWNER TO postgres;

--
-- Name: price_alert_watchdog; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.price_alert_watchdog (
    id boolean DEFAULT true NOT NULL,
    problem text,
    notify_after timestamp with time zone DEFAULT (now() + '00:02:00'::interval) NOT NULL,
    CONSTRAINT price_alert_watchdog_id_check CHECK (id)
);


ALTER TABLE public.price_alert_watchdog OWNER TO postgres;

--
-- Name: price_stream_health; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.price_stream_health (
    worker_id text NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    connected boolean NOT NULL,
    last_market_at timestamp with time zone,
    rules_refreshed_at timestamp with time zone,
    active_assets integer DEFAULT 0 NOT NULL,
    pending_occurrences integer DEFAULT 0 NOT NULL,
    unhealthy_since timestamp with time zone,
    oldest_pending_at timestamp with time zone,
    reconnects integer DEFAULT 0 NOT NULL,
    stale_assets jsonb DEFAULT '[]'::jsonb NOT NULL
);


ALTER TABLE public.price_stream_health OWNER TO postgres;

--
-- Name: rule_evaluation_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.rule_evaluation_state (
    rule_id uuid NOT NULL,
    bucket timestamp with time zone NOT NULL,
    status text NOT NULL,
    score double precision,
    tail_percentile double precision,
    reference_age_seconds integer,
    model_version text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rule_evaluation_state_status_check CHECK ((status = ANY (ARRAY['not_triggered'::text, 'triggered'::text, 'warming'::text, 'data_gap'::text, 'error'::text])))
);


ALTER TABLE public.rule_evaluation_state OWNER TO postgres;

--
-- Name: sign_in_email_limits; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sign_in_email_limits (
    limiter_key text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    last_sent_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT sign_in_email_limits_attempt_count_check CHECK ((attempt_count >= 0))
);


ALTER TABLE public.sign_in_email_limits OWNER TO postgres;

--
-- Name: strategy_actions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.strategy_actions (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    assignment_id uuid NOT NULL,
    evaluation_id uuid,
    action_kind text NOT NULL,
    idempotency_key text NOT NULL,
    paper_command_id uuid,
    state text DEFAULT 'pending'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome jsonb,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT strategy_actions_action_kind_check CHECK ((action_kind = ANY (ARRAY['entry'::text, 'exit'::text, 'pause_close'::text]))),
    CONSTRAINT strategy_actions_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 128))),
    CONSTRAINT strategy_actions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text])))
);


ALTER TABLE public.strategy_actions OWNER TO postgres;

--
-- Name: strategy_assignments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.strategy_assignments (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    account_id uuid NOT NULL,
    epoch_id uuid NOT NULL,
    asset text NOT NULL,
    margin_allocation_pct numeric(6,3) DEFAULT 10 NOT NULL,
    state text DEFAULT 'paused'::text NOT NULL,
    rearm_ready boolean DEFAULT true NOT NULL,
    last_five_minute_close timestamp with time zone,
    last_one_hour_close timestamp with time zone,
    degraded_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_net_return numeric(38,12),
    CONSTRAINT strategy_assignments_asset_check CHECK ((asset ~ '^[a-zA-Z0-9_.:-]+$'::text)),
    CONSTRAINT strategy_assignments_margin_allocation_pct_check CHECK (((margin_allocation_pct >= (1)::numeric) AND (margin_allocation_pct <= (100)::numeric))),
    CONSTRAINT strategy_assignments_state_check CHECK ((state = ANY (ARRAY['paused'::text, 'warming'::text, 'armed'::text, 'position_open'::text, 'await_rearm'::text, 'exit_managed_paused'::text, 'degraded'::text])))
);


ALTER TABLE public.strategy_assignments OWNER TO postgres;

--
-- Name: COLUMN strategy_assignments.last_net_return; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.strategy_assignments.last_net_return IS 'Latest executable strategy net PnL divided by entry initial margin; null when no live projection exists.';


--
-- Name: strategy_candles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.strategy_candles (
    asset text NOT NULL,
    "interval" text NOT NULL,
    open_time timestamp with time zone NOT NULL,
    close_time timestamp with time zone NOT NULL,
    open numeric(38,12) NOT NULL,
    high numeric(38,12) NOT NULL,
    low numeric(38,12) NOT NULL,
    close numeric(38,12) NOT NULL,
    volume numeric(38,12) NOT NULL,
    source text DEFAULT 'hyperliquid'::text NOT NULL,
    source_version text NOT NULL,
    collected_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT strategy_candles_check CHECK (((close_time > open_time) AND (high >= GREATEST(open, close)) AND (low <= LEAST(open, close)))),
    CONSTRAINT strategy_candles_close_check CHECK ((close > (0)::numeric)),
    CONSTRAINT strategy_candles_high_check CHECK ((high > (0)::numeric)),
    CONSTRAINT strategy_candles_interval_check CHECK (("interval" = ANY (ARRAY['5m'::text, '1h'::text]))),
    CONSTRAINT strategy_candles_low_check CHECK ((low > (0)::numeric)),
    CONSTRAINT strategy_candles_open_check CHECK ((open > (0)::numeric)),
    CONSTRAINT strategy_candles_volume_check CHECK ((volume >= (0)::numeric))
);


ALTER TABLE public.strategy_candles OWNER TO postgres;

--
-- Name: strategy_definitions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.strategy_definitions (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    strategy_kind text NOT NULL,
    active_revision_id uuid,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT strategy_definitions_name_check CHECK (((char_length(TRIM(BOTH FROM name)) >= 1) AND (char_length(TRIM(BOTH FROM name)) <= 80))),
    CONSTRAINT strategy_definitions_strategy_kind_check CHECK ((strategy_kind = 'dual_relative_rsi'::text))
);


ALTER TABLE public.strategy_definitions OWNER TO postgres;

--
-- Name: strategy_evaluations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.strategy_evaluations (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    assignment_id uuid NOT NULL,
    five_minute_close timestamp with time zone NOT NULL,
    one_hour_close timestamp with time zone,
    five_minute_values jsonb,
    one_hour_values jsonb,
    decision text NOT NULL,
    input_versions jsonb DEFAULT '{}'::jsonb NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT strategy_evaluations_decision_check CHECK ((decision = ANY (ARRAY['warming'::text, 'hold'::text, 'enter_long'::text, 'enter_short'::text, 'degraded'::text])))
);


ALTER TABLE public.strategy_evaluations OWNER TO postgres;

--
-- Name: strategy_operational_health; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.strategy_operational_health WITH (security_invoker='true') AS
 SELECT (( SELECT count(*) AS count
           FROM public.strategy_assignments
          WHERE (strategy_assignments.state <> 'paused'::text)))::integer AS active_assignments,
    (( SELECT count(*) AS count
           FROM public.strategy_assignments a
          WHERE ((a.state <> 'paused'::text) AND (EXISTS ( SELECT 1
                   FROM public.strategy_evaluations e
                  WHERE ((e.assignment_id = a.id) AND (e.created_at > (now() - '00:10:00'::interval))))))))::integer AS fresh_assignments,
    (( SELECT count(*) AS count
           FROM public.strategy_assignments
          WHERE (strategy_assignments.state = 'degraded'::text)))::integer AS degraded_assignments,
    (( SELECT count(*) AS count
           FROM public.strategy_actions
          WHERE (strategy_actions.state = 'failed'::text)))::integer AS failed_actions,
    (( SELECT count(*) AS count
           FROM public.backtest_runs
          WHERE (backtest_runs.status = ANY (ARRAY['queued'::text, 'running'::text]))))::integer AS pending_backtests,
    (( SELECT count(*) AS count
           FROM public.backtest_runs
          WHERE (backtest_runs.status = 'completed'::text)))::integer AS completed_backtests,
    (( SELECT count(*) AS count
           FROM public.backtest_runs
          WHERE (backtest_runs.status = 'failed'::text)))::integer AS failed_backtests,
    ( SELECT max(strategy_evaluations.created_at) AS max
           FROM public.strategy_evaluations) AS latest_evaluation_at;


ALTER VIEW public.strategy_operational_health OWNER TO postgres;

--
-- Name: strategy_positions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.strategy_positions (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    assignment_id uuid NOT NULL,
    paper_position_id uuid,
    side text NOT NULL,
    entry_size numeric(38,12) NOT NULL,
    entry_price numeric(38,12) NOT NULL,
    entry_initial_margin numeric(38,6) NOT NULL,
    entry_fees numeric(38,6) DEFAULT 0 NOT NULL,
    funding_cashflows numeric(38,6) DEFAULT 0 NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    exit_reason text,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT strategy_positions_entry_fees_check CHECK ((entry_fees >= (0)::numeric)),
    CONSTRAINT strategy_positions_entry_initial_margin_check CHECK ((entry_initial_margin > (0)::numeric)),
    CONSTRAINT strategy_positions_entry_price_check CHECK ((entry_price > (0)::numeric)),
    CONSTRAINT strategy_positions_entry_size_check CHECK ((entry_size > (0)::numeric)),
    CONSTRAINT strategy_positions_side_check CHECK ((side = ANY (ARRAY['long'::text, 'short'::text]))),
    CONSTRAINT strategy_positions_state_check CHECK ((state = ANY (ARRAY['open'::text, 'closing'::text, 'closed'::text, 'liquidated'::text])))
);


ALTER TABLE public.strategy_positions OWNER TO postgres;

--
-- Name: strategy_revisions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.strategy_revisions (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    definition_id uuid NOT NULL,
    revision_number integer NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    parameters jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT strategy_revisions_parameters_check CHECK (((parameters @> '{"longRatio": "0.1", "rsiPeriod": 14, "shortRatio": "1.9", "stopReturn": "-0.1", "takeReturn": "0.2", "baselineLength": 100}'::jsonb) AND ((((parameters ->> 'marginAllocationPct'::text))::numeric >= (1)::numeric) AND (((parameters ->> 'marginAllocationPct'::text))::numeric <= (100)::numeric)))),
    CONSTRAINT strategy_revisions_revision_number_check CHECK ((revision_number > 0)),
    CONSTRAINT strategy_revisions_schema_version_check CHECK ((schema_version = 1))
);


ALTER TABLE public.strategy_revisions OWNER TO postgres;

--
-- Name: trade_csv_uploads; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.trade_csv_uploads (
    user_id uuid NOT NULL,
    file_name text NOT NULL,
    file_size bigint NOT NULL,
    content_sha256 text NOT NULL,
    content text NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trade_csv_uploads_check CHECK ((file_size = octet_length(content))),
    CONSTRAINT trade_csv_uploads_content_check CHECK (((octet_length(content) >= 1) AND (octet_length(content) <= 10485760))),
    CONSTRAINT trade_csv_uploads_content_sha256_check CHECK ((content_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT trade_csv_uploads_file_name_check CHECK (((char_length(file_name) >= 1) AND (char_length(file_name) <= 255))),
    CONSTRAINT trade_csv_uploads_file_size_check CHECK (((file_size >= 1) AND (file_size <= 10485760)))
);


ALTER TABLE public.trade_csv_uploads OWNER TO postgres;

--
-- Name: trade_log_orders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.trade_log_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    asset text NOT NULL,
    side text NOT NULL,
    shares numeric NOT NULL,
    price numeric NOT NULL,
    executed_at timestamp with time zone NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trade_log_orders_asset_check CHECK (((char_length(asset) >= 1) AND (char_length(asset) <= 80))),
    CONSTRAINT trade_log_orders_note_check CHECK ((char_length(note) <= 500)),
    CONSTRAINT trade_log_orders_price_check CHECK ((price > (0)::numeric)),
    CONSTRAINT trade_log_orders_shares_check CHECK ((shares > (0)::numeric)),
    CONSTRAINT trade_log_orders_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text])))
);


ALTER TABLE public.trade_log_orders OWNER TO postgres;

--
-- Name: volatility_states; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.volatility_states (
    asset text NOT NULL,
    fast_variance double precision NOT NULL,
    slow_variance double precision NOT NULL,
    last_mark double precision NOT NULL,
    last_bucket timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT volatility_states_fast_variance_check CHECK (((fast_variance > (0)::double precision) AND (fast_variance < 'Infinity'::double precision))),
    CONSTRAINT volatility_states_last_mark_check CHECK (((last_mark > (0)::double precision) AND (last_mark < 'Infinity'::double precision))),
    CONSTRAINT volatility_states_slow_variance_check CHECK (((slow_variance > (0)::double precision) AND (slow_variance < 'Infinity'::double precision)))
);


ALTER TABLE public.volatility_states OWNER TO postgres;

--
-- Name: watchlist_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.watchlist_items (
    user_id uuid NOT NULL,
    asset text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT watchlist_items_asset_check CHECK ((char_length(asset) > 0))
);


ALTER TABLE public.watchlist_items OWNER TO postgres;

--
-- Name: alert_occurrences alert_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alert_occurrences
    ADD CONSTRAINT alert_occurrences_pkey PRIMARY KEY (id);


--
-- Name: alert_occurrences alert_occurrences_rule_id_bucket_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alert_occurrences
    ADD CONSTRAINT alert_occurrences_rule_id_bucket_key UNIQUE (rule_id, bucket);


--
-- Name: alert_rules alert_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_pkey PRIMARY KEY (id);


--
-- Name: alert_runtime_destination alert_runtime_destination_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alert_runtime_destination
    ADD CONSTRAINT alert_runtime_destination_pkey PRIMARY KEY (id);


--
-- Name: asset_analytics_cache asset_analytics_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asset_analytics_cache
    ADD CONSTRAINT asset_analytics_cache_pkey PRIMARY KEY (asset);


--
-- Name: audio_listener_assets audio_listener_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audio_listener_assets
    ADD CONSTRAINT audio_listener_assets_pkey PRIMARY KEY (user_id, asset);


--
-- Name: backtest_equity_points backtest_equity_points_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_equity_points
    ADD CONSTRAINT backtest_equity_points_pkey PRIMARY KEY (run_id, sampled_at, reason);


--
-- Name: backtest_runs backtest_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_runs
    ADD CONSTRAINT backtest_runs_pkey PRIMARY KEY (id);


--
-- Name: backtest_trades backtest_trades_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_trades
    ADD CONSTRAINT backtest_trades_pkey PRIMARY KEY (id);


--
-- Name: calibration_jobs calibration_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.calibration_jobs
    ADD CONSTRAINT calibration_jobs_pkey PRIMARY KEY (asset, horizon_minutes);


--
-- Name: detector_models detector_models_asset_horizon_minutes_detector_model_versio_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.detector_models
    ADD CONSTRAINT detector_models_asset_horizon_minutes_detector_model_versio_key UNIQUE (asset, horizon_minutes, detector, model_version);


--
-- Name: detector_models detector_models_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.detector_models
    ADD CONSTRAINT detector_models_pkey PRIMARY KEY (id);


--
-- Name: hyperliquid_account_fills hyperliquid_account_fills_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_fills
    ADD CONSTRAINT hyperliquid_account_fills_pkey PRIMARY KEY (account_address, trade_id);


--
-- Name: hyperliquid_account_funding hyperliquid_account_funding_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_funding
    ADD CONSTRAINT hyperliquid_account_funding_pkey PRIMARY KEY (account_address, event_key);


--
-- Name: hyperliquid_account_ledger hyperliquid_account_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_ledger
    ADD CONSTRAINT hyperliquid_account_ledger_pkey PRIMARY KEY (account_address, event_key);


--
-- Name: hyperliquid_account_position_tags hyperliquid_account_position_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_position_tags
    ADD CONSTRAINT hyperliquid_account_position_tags_pkey PRIMARY KEY (user_id, account_address, position_key);


--
-- Name: hyperliquid_account_positions hyperliquid_account_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_positions
    ADD CONSTRAINT hyperliquid_account_positions_pkey PRIMARY KEY (account_address, dex, asset);


--
-- Name: hyperliquid_account_sources hyperliquid_account_sources_address_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_sources
    ADD CONSTRAINT hyperliquid_account_sources_address_key UNIQUE (address);


--
-- Name: hyperliquid_account_sources hyperliquid_account_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_sources
    ADD CONSTRAINT hyperliquid_account_sources_pkey PRIMARY KEY (user_id);


--
-- Name: hyperliquid_account_sources hyperliquid_account_sources_user_id_address_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_sources
    ADD CONSTRAINT hyperliquid_account_sources_user_id_address_key UNIQUE (user_id, address);


--
-- Name: level_tool_preferences level_tool_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.level_tool_preferences
    ADD CONSTRAINT level_tool_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: market_observations market_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.market_observations
    ADD CONSTRAINT market_observations_pkey PRIMARY KEY (asset, bucket);


--
-- Name: monitor_runs monitor_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.monitor_runs
    ADD CONSTRAINT monitor_runs_pkey PRIMARY KEY (bucket);


--
-- Name: new_asset_acknowledgements new_asset_acknowledgements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_asset_acknowledgements
    ADD CONSTRAINT new_asset_acknowledgements_pkey PRIMARY KEY (user_id, asset);


--
-- Name: notification_outbox notification_outbox_occurrence_id_channel_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_occurrence_id_channel_key UNIQUE (occurrence_id, channel);


--
-- Name: notification_outbox notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: paper_account_epochs paper_account_epochs_account_id_epoch_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_account_epochs
    ADD CONSTRAINT paper_account_epochs_account_id_epoch_number_key UNIQUE (account_id, epoch_number);


--
-- Name: paper_account_epochs paper_account_epochs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_account_epochs
    ADD CONSTRAINT paper_account_epochs_pkey PRIMARY KEY (id);


--
-- Name: paper_account_market_cursors paper_account_market_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_account_market_cursors
    ADD CONSTRAINT paper_account_market_cursors_pkey PRIMARY KEY (epoch_id, asset);


--
-- Name: paper_account_summaries paper_account_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_account_summaries
    ADD CONSTRAINT paper_account_summaries_pkey PRIMARY KEY (epoch_id);


--
-- Name: paper_accounts paper_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_accounts
    ADD CONSTRAINT paper_accounts_pkey PRIMARY KEY (id);


--
-- Name: paper_commands paper_commands_epoch_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_commands
    ADD CONSTRAINT paper_commands_epoch_id_idempotency_key_key UNIQUE (epoch_id, idempotency_key);


--
-- Name: paper_commands paper_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_commands
    ADD CONSTRAINT paper_commands_pkey PRIMARY KEY (id);


--
-- Name: paper_fills paper_fills_epoch_id_source_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_fills
    ADD CONSTRAINT paper_fills_epoch_id_source_id_key UNIQUE (epoch_id, source_id);


--
-- Name: paper_fills paper_fills_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_fills
    ADD CONSTRAINT paper_fills_pkey PRIMARY KEY (id);


--
-- Name: paper_funding_payments paper_funding_payments_epoch_id_asset_funding_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_funding_payments
    ADD CONSTRAINT paper_funding_payments_epoch_id_asset_funding_timestamp_key UNIQUE (epoch_id, asset, funding_timestamp);


--
-- Name: paper_funding_payments paper_funding_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_funding_payments
    ADD CONSTRAINT paper_funding_payments_pkey PRIMARY KEY (id);


--
-- Name: paper_ledger_entries paper_ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_ledger_entries
    ADD CONSTRAINT paper_ledger_entries_pkey PRIMARY KEY (id);


--
-- Name: paper_leverage_settings paper_leverage_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_leverage_settings
    ADD CONSTRAINT paper_leverage_settings_pkey PRIMARY KEY (epoch_id, asset);


--
-- Name: paper_liquidations paper_liquidations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_liquidations
    ADD CONSTRAINT paper_liquidations_pkey PRIMARY KEY (id);


--
-- Name: paper_market_inputs paper_market_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_market_inputs
    ADD CONSTRAINT paper_market_inputs_pkey PRIMARY KEY (asset, input_kind, input_version);


--
-- Name: paper_orders paper_orders_epoch_id_client_order_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_orders
    ADD CONSTRAINT paper_orders_epoch_id_client_order_id_key UNIQUE (epoch_id, client_order_id);


--
-- Name: paper_orders paper_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_orders
    ADD CONSTRAINT paper_orders_pkey PRIMARY KEY (id);


--
-- Name: paper_positions paper_positions_epoch_id_asset_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_positions
    ADD CONSTRAINT paper_positions_epoch_id_asset_key UNIQUE (epoch_id, asset);


--
-- Name: paper_positions paper_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_positions
    ADD CONSTRAINT paper_positions_pkey PRIMARY KEY (id);


--
-- Name: paper_processor_lease paper_processor_lease_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_processor_lease
    ADD CONSTRAINT paper_processor_lease_pkey PRIMARY KEY (singleton);


--
-- Name: paper_processor_runs paper_processor_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_processor_runs
    ADD CONSTRAINT paper_processor_runs_pkey PRIMARY KEY (bucket);


--
-- Name: price_alert_watchdog price_alert_watchdog_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_alert_watchdog
    ADD CONSTRAINT price_alert_watchdog_pkey PRIMARY KEY (id);


--
-- Name: price_stream_health price_stream_health_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_stream_health
    ADD CONSTRAINT price_stream_health_pkey PRIMARY KEY (worker_id);


--
-- Name: rule_evaluation_state rule_evaluation_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rule_evaluation_state
    ADD CONSTRAINT rule_evaluation_state_pkey PRIMARY KEY (rule_id);


--
-- Name: sign_in_email_limits sign_in_email_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sign_in_email_limits
    ADD CONSTRAINT sign_in_email_limits_pkey PRIMARY KEY (limiter_key);


--
-- Name: strategy_actions strategy_actions_assignment_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_actions
    ADD CONSTRAINT strategy_actions_assignment_id_idempotency_key_key UNIQUE (assignment_id, idempotency_key);


--
-- Name: strategy_actions strategy_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_actions
    ADD CONSTRAINT strategy_actions_pkey PRIMARY KEY (id);


--
-- Name: strategy_assignments strategy_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_assignments
    ADD CONSTRAINT strategy_assignments_pkey PRIMARY KEY (id);


--
-- Name: strategy_candles strategy_candles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_candles
    ADD CONSTRAINT strategy_candles_pkey PRIMARY KEY (asset, "interval", open_time);


--
-- Name: strategy_definitions strategy_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_definitions
    ADD CONSTRAINT strategy_definitions_pkey PRIMARY KEY (id);


--
-- Name: strategy_evaluations strategy_evaluations_assignment_id_five_minute_close_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_evaluations
    ADD CONSTRAINT strategy_evaluations_assignment_id_five_minute_close_key UNIQUE (assignment_id, five_minute_close);


--
-- Name: strategy_evaluations strategy_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_evaluations
    ADD CONSTRAINT strategy_evaluations_pkey PRIMARY KEY (id);


--
-- Name: strategy_positions strategy_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_positions
    ADD CONSTRAINT strategy_positions_pkey PRIMARY KEY (id);


--
-- Name: strategy_revisions strategy_revisions_definition_id_revision_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_revisions
    ADD CONSTRAINT strategy_revisions_definition_id_revision_number_key UNIQUE (definition_id, revision_number);


--
-- Name: strategy_revisions strategy_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_revisions
    ADD CONSTRAINT strategy_revisions_pkey PRIMARY KEY (id);


--
-- Name: trade_csv_uploads trade_csv_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trade_csv_uploads
    ADD CONSTRAINT trade_csv_uploads_pkey PRIMARY KEY (user_id);


--
-- Name: trade_log_orders trade_log_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trade_log_orders
    ADD CONSTRAINT trade_log_orders_pkey PRIMARY KEY (id);


--
-- Name: volatility_states volatility_states_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.volatility_states
    ADD CONSTRAINT volatility_states_pkey PRIMARY KEY (asset);


--
-- Name: watchlist_items watchlist_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.watchlist_items
    ADD CONSTRAINT watchlist_items_pkey PRIMARY KEY (user_id, asset);


--
-- Name: alert_occurrences_user_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX alert_occurrences_user_created_idx ON public.alert_occurrences USING btree (user_id, created_at DESC);


--
-- Name: alert_rules_active_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX alert_rules_active_idx ON public.alert_rules USING btree (asset, detector) WHERE (enabled AND (deleted_at IS NULL));


--
-- Name: backtest_trades_replay_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX backtest_trades_replay_uidx ON public.backtest_trades USING btree (run_id, scope, asset, side, entry_time, exit_time);


--
-- Name: detector_models_current_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX detector_models_current_idx ON public.detector_models USING btree (asset, horizon_minutes, detector, expires_at DESC);


--
-- Name: hyperliquid_account_fills_user_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX hyperliquid_account_fills_user_time_idx ON public.hyperliquid_account_fills USING btree (user_id, occurred_at DESC, trade_id);


--
-- Name: hyperliquid_account_funding_user_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX hyperliquid_account_funding_user_time_idx ON public.hyperliquid_account_funding USING btree (user_id, occurred_at DESC);


--
-- Name: hyperliquid_account_ledger_user_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX hyperliquid_account_ledger_user_time_idx ON public.hyperliquid_account_ledger USING btree (user_id, occurred_at DESC);


--
-- Name: market_observations_bucket_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX market_observations_bucket_idx ON public.market_observations USING btree (bucket);


--
-- Name: notification_outbox_due_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX notification_outbox_due_idx ON public.notification_outbox USING btree (next_attempt_at, created_at) WHERE (state = ANY (ARRAY['queued'::text, 'retry_wait'::text, 'claimed'::text]));


--
-- Name: paper_account_epochs_one_active_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX paper_account_epochs_one_active_idx ON public.paper_account_epochs USING btree (account_id) WHERE (state = 'active'::text);


--
-- Name: paper_accounts_active_name_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX paper_accounts_active_name_uidx ON public.paper_accounts USING btree (user_id, lower(TRIM(BOTH FROM name))) WHERE (archived_at IS NULL);


--
-- Name: paper_fills_epoch_asset_source_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX paper_fills_epoch_asset_source_timestamp_idx ON public.paper_fills USING btree (epoch_id, asset, source_timestamp);


--
-- Name: paper_fills_epoch_source_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX paper_fills_epoch_source_timestamp_idx ON public.paper_fills USING btree (epoch_id, source_timestamp);


--
-- Name: paper_ledger_entries_epoch_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX paper_ledger_entries_epoch_idx ON public.paper_ledger_entries USING btree (epoch_id, created_at);


--
-- Name: paper_market_inputs_asset_kind_source_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX paper_market_inputs_asset_kind_source_idx ON public.paper_market_inputs USING btree (asset, input_kind, source_timestamp DESC);


--
-- Name: paper_orders_active_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX paper_orders_active_idx ON public.paper_orders USING btree (epoch_id, asset, status) WHERE (status = ANY (ARRAY['resting'::text, 'trigger_waiting'::text, 'partially_filled'::text]));


--
-- Name: strategy_assignments_one_controller_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX strategy_assignments_one_controller_idx ON public.strategy_assignments USING btree (epoch_id, asset) WHERE (state <> 'paused'::text);


--
-- Name: strategy_definitions_owner_name_uidx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX strategy_definitions_owner_name_uidx ON public.strategy_definitions USING btree (user_id, lower(TRIM(BOTH FROM name))) WHERE (archived_at IS NULL);


--
-- Name: strategy_positions_one_open_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX strategy_positions_one_open_idx ON public.strategy_positions USING btree (assignment_id) WHERE (state = ANY (ARRAY['open'::text, 'closing'::text]));


--
-- Name: trade_log_orders_user_execution_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX trade_log_orders_user_execution_idx ON public.trade_log_orders USING btree (user_id, executed_at, created_at, id);


--
-- Name: alert_rules alert_rules_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER alert_rules_set_updated_at BEFORE UPDATE ON public.alert_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: asset_analytics_cache asset_analytics_cache_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER asset_analytics_cache_set_updated_at BEFORE UPDATE ON public.asset_analytics_cache FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: calibration_jobs calibration_jobs_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER calibration_jobs_set_updated_at BEFORE UPDATE ON public.calibration_jobs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: alert_rules fixed_alert_delivery; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER fixed_alert_delivery BEFORE INSERT OR UPDATE ON public.alert_rules FOR EACH ROW EXECUTE FUNCTION public.fixed_alert_delivery();


--
-- Name: alert_rules guard_migrated_alert_rules; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER guard_migrated_alert_rules BEFORE INSERT OR DELETE OR UPDATE ON public.alert_rules FOR EACH ROW EXECUTE FUNCTION public.guard_migrated_alert_rules();


--
-- Name: hyperliquid_account_position_tags hyperliquid_account_position_tags_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER hyperliquid_account_position_tags_set_updated_at BEFORE UPDATE ON public.hyperliquid_account_position_tags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: level_tool_preferences level_tool_preferences_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER level_tool_preferences_set_updated_at BEFORE UPDATE ON public.level_tool_preferences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: notification_outbox notification_outbox_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER notification_outbox_set_updated_at BEFORE UPDATE ON public.notification_outbox FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: paper_account_summaries paper_account_summaries_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER paper_account_summaries_set_updated_at BEFORE UPDATE ON public.paper_account_summaries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: paper_accounts paper_accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER paper_accounts_set_updated_at BEFORE UPDATE ON public.paper_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: paper_commands paper_commands_strategy_owner_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER paper_commands_strategy_owner_guard BEFORE INSERT ON public.paper_commands FOR EACH ROW EXECUTE FUNCTION public.guard_strategy_owned_paper_command();


--
-- Name: paper_account_epochs paper_epoch_reset_disables_strategies; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER paper_epoch_reset_disables_strategies AFTER UPDATE OF state ON public.paper_account_epochs FOR EACH ROW EXECUTE FUNCTION public.disable_reset_epoch_strategies();


--
-- Name: strategy_actions strategy_actions_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER strategy_actions_set_updated_at BEFORE UPDATE ON public.strategy_actions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: strategy_assignments strategy_assignments_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER strategy_assignments_set_updated_at BEFORE UPDATE ON public.strategy_assignments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: strategy_definitions strategy_definitions_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER strategy_definitions_set_updated_at BEFORE UPDATE ON public.strategy_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: strategy_revisions strategy_revisions_immutable; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER strategy_revisions_immutable BEFORE DELETE OR UPDATE ON public.strategy_revisions FOR EACH ROW EXECUTE FUNCTION public.reject_strategy_revision_mutation();


--
-- Name: trade_log_orders validate_trade_log_share_balance; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER validate_trade_log_share_balance AFTER INSERT OR DELETE ON public.trade_log_orders FOR EACH ROW EXECUTE FUNCTION public.validate_trade_log_share_balance();


--
-- Name: alert_occurrences alert_occurrences_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alert_occurrences
    ADD CONSTRAINT alert_occurrences_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.alert_rules(id);


--
-- Name: alert_occurrences alert_occurrences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alert_occurrences
    ADD CONSTRAINT alert_occurrences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: alert_rules alert_rules_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: audio_listener_assets audio_listener_assets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audio_listener_assets
    ADD CONSTRAINT audio_listener_assets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: backtest_equity_points backtest_equity_points_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_equity_points
    ADD CONSTRAINT backtest_equity_points_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.backtest_runs(id) ON DELETE CASCADE;


--
-- Name: backtest_runs backtest_runs_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_runs
    ADD CONSTRAINT backtest_runs_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.strategy_revisions(id);


--
-- Name: backtest_runs backtest_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_runs
    ADD CONSTRAINT backtest_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: backtest_trades backtest_trades_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_trades
    ADD CONSTRAINT backtest_trades_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.backtest_runs(id) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_fills hyperliquid_account_fills_user_id_account_address_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_fills
    ADD CONSTRAINT hyperliquid_account_fills_user_id_account_address_fkey FOREIGN KEY (user_id, account_address) REFERENCES public.hyperliquid_account_sources(user_id, address) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_fills hyperliquid_account_fills_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_fills
    ADD CONSTRAINT hyperliquid_account_fills_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_funding hyperliquid_account_funding_user_id_account_address_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_funding
    ADD CONSTRAINT hyperliquid_account_funding_user_id_account_address_fkey FOREIGN KEY (user_id, account_address) REFERENCES public.hyperliquid_account_sources(user_id, address) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_funding hyperliquid_account_funding_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_funding
    ADD CONSTRAINT hyperliquid_account_funding_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_ledger hyperliquid_account_ledger_user_id_account_address_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_ledger
    ADD CONSTRAINT hyperliquid_account_ledger_user_id_account_address_fkey FOREIGN KEY (user_id, account_address) REFERENCES public.hyperliquid_account_sources(user_id, address) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_ledger hyperliquid_account_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_ledger
    ADD CONSTRAINT hyperliquid_account_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_position_tags hyperliquid_account_position_tags_user_id_account_address_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_position_tags
    ADD CONSTRAINT hyperliquid_account_position_tags_user_id_account_address_fkey FOREIGN KEY (user_id, account_address) REFERENCES public.hyperliquid_account_sources(user_id, address) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_position_tags hyperliquid_account_position_tags_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_position_tags
    ADD CONSTRAINT hyperliquid_account_position_tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_positions hyperliquid_account_positions_user_id_account_address_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_positions
    ADD CONSTRAINT hyperliquid_account_positions_user_id_account_address_fkey FOREIGN KEY (user_id, account_address) REFERENCES public.hyperliquid_account_sources(user_id, address) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_positions hyperliquid_account_positions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_positions
    ADD CONSTRAINT hyperliquid_account_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_sources hyperliquid_account_sources_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.hyperliquid_account_sources
    ADD CONSTRAINT hyperliquid_account_sources_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: level_tool_preferences level_tool_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.level_tool_preferences
    ADD CONSTRAINT level_tool_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: new_asset_acknowledgements new_asset_acknowledgements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.new_asset_acknowledgements
    ADD CONSTRAINT new_asset_acknowledgements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notification_outbox notification_outbox_occurrence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_occurrence_id_fkey FOREIGN KEY (occurrence_id) REFERENCES public.alert_occurrences(id) ON DELETE CASCADE;


--
-- Name: notification_outbox notification_outbox_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: paper_account_epochs paper_account_epochs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_account_epochs
    ADD CONSTRAINT paper_account_epochs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.paper_accounts(id) ON DELETE CASCADE;


--
-- Name: paper_account_market_cursors paper_account_market_cursors_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_account_market_cursors
    ADD CONSTRAINT paper_account_market_cursors_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_account_summaries paper_account_summaries_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_account_summaries
    ADD CONSTRAINT paper_account_summaries_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_accounts paper_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_accounts
    ADD CONSTRAINT paper_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: paper_commands paper_commands_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_commands
    ADD CONSTRAINT paper_commands_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_fills paper_fills_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_fills
    ADD CONSTRAINT paper_fills_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_fills paper_fills_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_fills
    ADD CONSTRAINT paper_fills_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.paper_orders(id);


--
-- Name: paper_funding_payments paper_funding_payments_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_funding_payments
    ADD CONSTRAINT paper_funding_payments_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_ledger_entries paper_ledger_entries_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_ledger_entries
    ADD CONSTRAINT paper_ledger_entries_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_leverage_settings paper_leverage_settings_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_leverage_settings
    ADD CONSTRAINT paper_leverage_settings_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_liquidations paper_liquidations_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_liquidations
    ADD CONSTRAINT paper_liquidations_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_orders paper_orders_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_orders
    ADD CONSTRAINT paper_orders_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: paper_orders paper_orders_parent_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_orders
    ADD CONSTRAINT paper_orders_parent_order_id_fkey FOREIGN KEY (parent_order_id) REFERENCES public.paper_orders(id);


--
-- Name: paper_positions paper_positions_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_positions
    ADD CONSTRAINT paper_positions_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: rule_evaluation_state rule_evaluation_state_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rule_evaluation_state
    ADD CONSTRAINT rule_evaluation_state_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.alert_rules(id) ON DELETE CASCADE;


--
-- Name: strategy_actions strategy_actions_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_actions
    ADD CONSTRAINT strategy_actions_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.strategy_assignments(id) ON DELETE CASCADE;


--
-- Name: strategy_actions strategy_actions_evaluation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_actions
    ADD CONSTRAINT strategy_actions_evaluation_id_fkey FOREIGN KEY (evaluation_id) REFERENCES public.strategy_evaluations(id);


--
-- Name: strategy_actions strategy_actions_paper_command_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_actions
    ADD CONSTRAINT strategy_actions_paper_command_id_fkey FOREIGN KEY (paper_command_id) REFERENCES public.paper_commands(id);


--
-- Name: strategy_assignments strategy_assignments_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_assignments
    ADD CONSTRAINT strategy_assignments_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.paper_accounts(id) ON DELETE CASCADE;


--
-- Name: strategy_assignments strategy_assignments_epoch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_assignments
    ADD CONSTRAINT strategy_assignments_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES public.paper_account_epochs(id) ON DELETE CASCADE;


--
-- Name: strategy_assignments strategy_assignments_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_assignments
    ADD CONSTRAINT strategy_assignments_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.strategy_revisions(id);


--
-- Name: strategy_assignments strategy_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_assignments
    ADD CONSTRAINT strategy_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: strategy_definitions strategy_definitions_active_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_definitions
    ADD CONSTRAINT strategy_definitions_active_revision_fk FOREIGN KEY (active_revision_id) REFERENCES public.strategy_revisions(id);


--
-- Name: strategy_definitions strategy_definitions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_definitions
    ADD CONSTRAINT strategy_definitions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: strategy_evaluations strategy_evaluations_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_evaluations
    ADD CONSTRAINT strategy_evaluations_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.strategy_assignments(id) ON DELETE CASCADE;


--
-- Name: strategy_positions strategy_positions_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_positions
    ADD CONSTRAINT strategy_positions_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.strategy_assignments(id) ON DELETE CASCADE;


--
-- Name: strategy_positions strategy_positions_paper_position_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_positions
    ADD CONSTRAINT strategy_positions_paper_position_id_fkey FOREIGN KEY (paper_position_id) REFERENCES public.paper_positions(id);


--
-- Name: strategy_revisions strategy_revisions_definition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.strategy_revisions
    ADD CONSTRAINT strategy_revisions_definition_id_fkey FOREIGN KEY (definition_id) REFERENCES public.strategy_definitions(id) ON DELETE CASCADE;


--
-- Name: trade_csv_uploads trade_csv_uploads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trade_csv_uploads
    ADD CONSTRAINT trade_csv_uploads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: trade_log_orders trade_log_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trade_log_orders
    ADD CONSTRAINT trade_log_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: watchlist_items watchlist_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.watchlist_items
    ADD CONSTRAINT watchlist_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: hyperliquid_account_position_tags Owner manages account position tags; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner manages account position tags" ON public.hyperliquid_account_position_tags TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text))) WITH CHECK (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: alert_rules Owner manages alert rules; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner manages alert rules" ON public.alert_rules TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text))) WITH CHECK (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: level_tool_preferences Owner manages level tool preferences; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner manages level tool preferences" ON public.level_tool_preferences TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text))) WITH CHECK (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: backtest_equity_points Owner reads backtest equity; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads backtest equity" ON public.backtest_equity_points FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.backtest_runs r
  WHERE ((r.id = backtest_equity_points.run_id) AND (r.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: backtest_runs Owner reads backtest runs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads backtest runs" ON public.backtest_runs FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: backtest_trades Owner reads backtest trades; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads backtest trades" ON public.backtest_trades FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.backtest_runs r
  WHERE ((r.id = backtest_trades.run_id) AND (r.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: notification_outbox Owner reads delivery status; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads delivery status" ON public.notification_outbox FOR SELECT TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: hyperliquid_account_fills Owner reads hyperliquid_account_fills; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads hyperliquid_account_fills" ON public.hyperliquid_account_fills FOR SELECT TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: hyperliquid_account_funding Owner reads hyperliquid_account_funding; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads hyperliquid_account_funding" ON public.hyperliquid_account_funding FOR SELECT TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: hyperliquid_account_ledger Owner reads hyperliquid_account_ledger; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads hyperliquid_account_ledger" ON public.hyperliquid_account_ledger FOR SELECT TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: hyperliquid_account_positions Owner reads hyperliquid_account_positions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads hyperliquid_account_positions" ON public.hyperliquid_account_positions FOR SELECT TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: hyperliquid_account_sources Owner reads hyperliquid_account_sources; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads hyperliquid_account_sources" ON public.hyperliquid_account_sources FOR SELECT TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: monitor_runs Owner reads monitor health; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads monitor health" ON public.monitor_runs FOR SELECT TO authenticated USING (((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text));


--
-- Name: alert_occurrences Owner reads occurrences; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads occurrences" ON public.alert_occurrences FOR SELECT TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: paper_accounts Owner reads paper accounts; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper accounts" ON public.paper_accounts FOR SELECT TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: paper_account_epochs Owner reads paper epochs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper epochs" ON public.paper_account_epochs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.paper_accounts a
  WHERE ((a.id = paper_account_epochs.account_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_processor_runs Owner reads paper processor health; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper processor health" ON public.paper_processor_runs FOR SELECT TO authenticated USING (((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text));


--
-- Name: paper_account_summaries Owner reads paper summaries; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper summaries" ON public.paper_account_summaries FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_account_summaries.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_commands Owner reads paper_commands; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper_commands" ON public.paper_commands FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_commands.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_fills Owner reads paper_fills; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper_fills" ON public.paper_fills FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_fills.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_funding_payments Owner reads paper_funding_payments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper_funding_payments" ON public.paper_funding_payments FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_funding_payments.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_ledger_entries Owner reads paper_ledger_entries; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper_ledger_entries" ON public.paper_ledger_entries FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_ledger_entries.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_leverage_settings Owner reads paper_leverage_settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper_leverage_settings" ON public.paper_leverage_settings FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_leverage_settings.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_liquidations Owner reads paper_liquidations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper_liquidations" ON public.paper_liquidations FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_liquidations.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_orders Owner reads paper_orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper_orders" ON public.paper_orders FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_orders.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: paper_positions Owner reads paper_positions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads paper_positions" ON public.paper_positions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.paper_account_epochs e
     JOIN public.paper_accounts a ON ((a.id = e.account_id)))
  WHERE ((e.id = paper_positions.epoch_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: price_stream_health Owner reads price stream health; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads price stream health" ON public.price_stream_health FOR SELECT TO authenticated USING (((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text));


--
-- Name: rule_evaluation_state Owner reads rule state; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads rule state" ON public.rule_evaluation_state FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.alert_rules r
  WHERE ((r.id = rule_evaluation_state.rule_id) AND (r.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: strategy_actions Owner reads strategy actions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads strategy actions" ON public.strategy_actions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.strategy_assignments a
  WHERE ((a.id = strategy_actions.assignment_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: strategy_assignments Owner reads strategy assignments; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads strategy assignments" ON public.strategy_assignments FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: strategy_definitions Owner reads strategy definitions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads strategy definitions" ON public.strategy_definitions FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: strategy_evaluations Owner reads strategy evaluations; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads strategy evaluations" ON public.strategy_evaluations FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.strategy_assignments a
  WHERE ((a.id = strategy_evaluations.assignment_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: strategy_positions Owner reads strategy positions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads strategy positions" ON public.strategy_positions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.strategy_assignments a
  WHERE ((a.id = strategy_positions.assignment_id) AND (a.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: strategy_revisions Owner reads strategy revisions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owner reads strategy revisions" ON public.strategy_revisions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.strategy_definitions d
  WHERE ((d.id = strategy_revisions.definition_id) AND (d.user_id = auth.uid()) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)))));


--
-- Name: audio_listener_assets Users manage their own audio assets; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users manage their own audio assets" ON public.audio_listener_assets TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text))) WITH CHECK (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: new_asset_acknowledgements Users manage their own new asset acknowledgements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users manage their own new asset acknowledgements" ON public.new_asset_acknowledgements TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text))) WITH CHECK (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: trade_csv_uploads Users manage their own trade CSV upload; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users manage their own trade CSV upload" ON public.trade_csv_uploads TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text))) WITH CHECK (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: trade_log_orders Users manage their own trade log; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users manage their own trade log" ON public.trade_log_orders TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text))) WITH CHECK (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: watchlist_items Users manage their own watchlist; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users manage their own watchlist" ON public.watchlist_items TO authenticated USING (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text))) WITH CHECK (((auth.uid() = user_id) AND ((auth.jwt() ->> 'email'::text) = 'jasonblick@zohomail.com'::text)));


--
-- Name: alert_occurrences; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.alert_occurrences ENABLE ROW LEVEL SECURITY;

--
-- Name: alert_rules; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: alert_runtime_destination; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.alert_runtime_destination ENABLE ROW LEVEL SECURITY;

--
-- Name: asset_analytics_cache; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.asset_analytics_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: asset_analytics_cache asset_analytics_cache_public_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY asset_analytics_cache_public_read ON public.asset_analytics_cache FOR SELECT TO authenticated, anon USING (true);


--
-- Name: audio_listener_assets; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.audio_listener_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: backtest_equity_points; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.backtest_equity_points ENABLE ROW LEVEL SECURITY;

--
-- Name: backtest_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.backtest_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: backtest_trades; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.backtest_trades ENABLE ROW LEVEL SECURITY;

--
-- Name: calibration_jobs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.calibration_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: detector_models; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.detector_models ENABLE ROW LEVEL SECURITY;

--
-- Name: hyperliquid_account_fills; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hyperliquid_account_fills ENABLE ROW LEVEL SECURITY;

--
-- Name: hyperliquid_account_funding; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hyperliquid_account_funding ENABLE ROW LEVEL SECURITY;

--
-- Name: hyperliquid_account_ledger; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hyperliquid_account_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: hyperliquid_account_position_tags; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hyperliquid_account_position_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: hyperliquid_account_positions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hyperliquid_account_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: hyperliquid_account_sources; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.hyperliquid_account_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: level_tool_preferences; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.level_tool_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: market_observations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.market_observations ENABLE ROW LEVEL SECURITY;

--
-- Name: monitor_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.monitor_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: new_asset_acknowledgements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.new_asset_acknowledgements ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_outbox; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_account_epochs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_account_epochs ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_account_market_cursors; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_account_market_cursors ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_account_summaries; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_account_summaries ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_accounts; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_commands; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_commands ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_fills; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_fills ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_funding_payments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_funding_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_ledger_entries; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_ledger_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_leverage_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_leverage_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_liquidations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_liquidations ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_market_inputs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_market_inputs ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_orders; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_positions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_processor_lease; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_processor_lease ENABLE ROW LEVEL SECURITY;

--
-- Name: paper_processor_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.paper_processor_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: price_alert_watchdog; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.price_alert_watchdog ENABLE ROW LEVEL SECURITY;

--
-- Name: price_stream_health; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.price_stream_health ENABLE ROW LEVEL SECURITY;

--
-- Name: rule_evaluation_state; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.rule_evaluation_state ENABLE ROW LEVEL SECURITY;

--
-- Name: sign_in_email_limits; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.sign_in_email_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: strategy_actions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.strategy_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: strategy_assignments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.strategy_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: strategy_candles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.strategy_candles ENABLE ROW LEVEL SECURITY;

--
-- Name: strategy_definitions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.strategy_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: strategy_evaluations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.strategy_evaluations ENABLE ROW LEVEL SECURITY;

--
-- Name: strategy_positions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.strategy_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: strategy_revisions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.strategy_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: trade_csv_uploads; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.trade_csv_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: trade_log_orders; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.trade_log_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: volatility_states; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.volatility_states ENABLE ROW LEVEL SECURITY;

--
-- Name: watchlist_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.watchlist_items ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION apply_paper_account_snapshot(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_replay_effects jsonb, p_funding_effects jsonb, p_mark_price numeric, p_input_version text, p_cursor jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.apply_paper_account_snapshot(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_replay_effects jsonb, p_funding_effects jsonb, p_mark_price numeric, p_input_version text, p_cursor jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_paper_account_snapshot(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_replay_effects jsonb, p_funding_effects jsonb, p_mark_price numeric, p_input_version text, p_cursor jsonb) TO service_role;


--
-- Name: FUNCTION apply_paper_effects(p_account_id uuid, p_epoch_number integer, p_expected_version bigint, p_idempotency_key text, p_effects jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.apply_paper_effects(p_account_id uuid, p_epoch_number integer, p_expected_version bigint, p_idempotency_key text, p_effects jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_paper_effects(p_account_id uuid, p_epoch_number integer, p_expected_version bigint, p_idempotency_key text, p_effects jsonb) TO service_role;


--
-- Name: FUNCTION apply_paper_funding_effect(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_effect jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.apply_paper_funding_effect(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_effect jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_paper_funding_effect(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_effect jsonb) TO service_role;


--
-- Name: FUNCTION apply_paper_liquidation_effect(p_epoch_id uuid, p_expected_version bigint, p_effect jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.apply_paper_liquidation_effect(p_epoch_id uuid, p_expected_version bigint, p_effect jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_paper_liquidation_effect(p_epoch_id uuid, p_expected_version bigint, p_effect jsonb) TO service_role;


--
-- Name: FUNCTION apply_paper_replay_effect(p_epoch_id uuid, p_expected_version bigint, p_effects jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.apply_paper_replay_effect(p_epoch_id uuid, p_expected_version bigint, p_effects jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_paper_replay_effect(p_epoch_id uuid, p_expected_version bigint, p_effects jsonb) TO service_role;


--
-- Name: FUNCTION archive_paper_account(p_account_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.archive_paper_account(p_account_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.archive_paper_account(p_account_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.archive_paper_account(p_account_id uuid) TO authenticated;


--
-- Name: FUNCTION cancel_paper_order(p_account_id uuid, p_order_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.cancel_paper_order(p_account_id uuid, p_order_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_paper_order(p_account_id uuid, p_order_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.cancel_paper_order(p_account_id uuid, p_order_id uuid) TO authenticated;


--
-- Name: TABLE calibration_jobs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.calibration_jobs TO service_role;


--
-- Name: FUNCTION claim_calibration_jobs(p_limit integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_calibration_jobs(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_calibration_jobs(p_limit integer) TO service_role;


--
-- Name: FUNCTION claim_hyperliquid_account_source(p_lease_seconds integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_hyperliquid_account_source(p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_hyperliquid_account_source(p_lease_seconds integer) TO service_role;


--
-- Name: FUNCTION claim_monitor_bucket(p_bucket timestamp with time zone); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_monitor_bucket(p_bucket timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_monitor_bucket(p_bucket timestamp with time zone) TO service_role;


--
-- Name: TABLE notification_outbox; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.notification_outbox TO service_role;
GRANT SELECT ON TABLE public.notification_outbox TO authenticated;


--
-- Name: FUNCTION claim_outbox(p_limit integer, p_channel text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_outbox(p_limit integer, p_channel text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_outbox(p_limit integer, p_channel text) TO service_role;


--
-- Name: FUNCTION claim_paper_processor_bucket(p_bucket timestamp with time zone); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_paper_processor_bucket(p_bucket timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_paper_processor_bucket(p_bucket timestamp with time zone) TO service_role;


--
-- Name: FUNCTION claim_price_alert_incident(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_price_alert_incident() FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_price_alert_incident() TO service_role;


--
-- Name: FUNCTION claim_sign_in_email_delivery(p_now timestamp with time zone); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_sign_in_email_delivery(p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_sign_in_email_delivery(p_now timestamp with time zone) TO service_role;


--
-- Name: FUNCTION configure_hyperliquid_account_cron(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.configure_hyperliquid_account_cron() FROM PUBLIC;
GRANT ALL ON FUNCTION public.configure_hyperliquid_account_cron() TO service_role;


--
-- Name: FUNCTION configure_legacy_listener_cron(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.configure_legacy_listener_cron() FROM PUBLIC;


--
-- Name: FUNCTION configure_listener_cron(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.configure_listener_cron() FROM PUBLIC;
GRANT ALL ON FUNCTION public.configure_listener_cron() TO service_role;


--
-- Name: FUNCTION configure_paper_cron(p_enabled boolean); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.configure_paper_cron(p_enabled boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.configure_paper_cron(p_enabled boolean) TO service_role;


--
-- Name: FUNCTION configure_paper_mutation_access(p_enabled boolean); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.configure_paper_mutation_access(p_enabled boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.configure_paper_mutation_access(p_enabled boolean) TO service_role;


--
-- Name: FUNCTION configure_strategy_mutation_access(p_enabled boolean); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.configure_strategy_mutation_access(p_enabled boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.configure_strategy_mutation_access(p_enabled boolean) TO service_role;


--
-- Name: FUNCTION valid_alert_configuration(detector_name text, config jsonb); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.valid_alert_configuration(detector_name text, config jsonb) TO anon;
GRANT ALL ON FUNCTION public.valid_alert_configuration(detector_name text, config jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.valid_alert_configuration(detector_name text, config jsonb) TO service_role;


--
-- Name: TABLE alert_rules; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.alert_rules TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.alert_rules TO authenticated;


--
-- Name: FUNCTION create_alert_rule(p_asset text, p_dex text, p_detector text, p_configuration jsonb, p_delivery text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.create_alert_rule(p_asset text, p_dex text, p_detector text, p_configuration jsonb, p_delivery text) TO anon;
GRANT ALL ON FUNCTION public.create_alert_rule(p_asset text, p_dex text, p_detector text, p_configuration jsonb, p_delivery text) TO authenticated;
GRANT ALL ON FUNCTION public.create_alert_rule(p_asset text, p_dex text, p_detector text, p_configuration jsonb, p_delivery text) TO service_role;


--
-- Name: FUNCTION create_dual_rsi_revision(p_definition_id uuid, p_margin_allocation_pct numeric); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_dual_rsi_revision(p_definition_id uuid, p_margin_allocation_pct numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_dual_rsi_revision(p_definition_id uuid, p_margin_allocation_pct numeric) TO service_role;
GRANT ALL ON FUNCTION public.create_dual_rsi_revision(p_definition_id uuid, p_margin_allocation_pct numeric) TO authenticated;


--
-- Name: FUNCTION create_dual_rsi_strategy(p_name text, p_margin_allocation_pct numeric); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_dual_rsi_strategy(p_name text, p_margin_allocation_pct numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_dual_rsi_strategy(p_name text, p_margin_allocation_pct numeric) TO service_role;
GRANT ALL ON FUNCTION public.create_dual_rsi_strategy(p_name text, p_margin_allocation_pct numeric) TO authenticated;


--
-- Name: FUNCTION create_paper_account(p_name text, p_starting_capital numeric); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_paper_account(p_name text, p_starting_capital numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_paper_account(p_name text, p_starting_capital numeric) TO service_role;
GRANT ALL ON FUNCTION public.create_paper_account(p_name text, p_starting_capital numeric) TO authenticated;


--
-- Name: FUNCTION create_strategy_assignment(p_definition_id uuid, p_account_id uuid, p_asset text, p_margin_allocation_pct numeric); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_strategy_assignment(p_definition_id uuid, p_account_id uuid, p_asset text, p_margin_allocation_pct numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_strategy_assignment(p_definition_id uuid, p_account_id uuid, p_asset text, p_margin_allocation_pct numeric) TO service_role;
GRANT ALL ON FUNCTION public.create_strategy_assignment(p_definition_id uuid, p_account_id uuid, p_asset text, p_margin_allocation_pct numeric) TO authenticated;


--
-- Name: FUNCTION delete_alert_rule(p_rule_id uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.delete_alert_rule(p_rule_id uuid) TO anon;
GRANT ALL ON FUNCTION public.delete_alert_rule(p_rule_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.delete_alert_rule(p_rule_id uuid) TO service_role;


--
-- Name: FUNCTION disable_reset_epoch_strategies(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.disable_reset_epoch_strategies() TO anon;
GRANT ALL ON FUNCTION public.disable_reset_epoch_strategies() TO authenticated;
GRANT ALL ON FUNCTION public.disable_reset_epoch_strategies() TO service_role;


--
-- Name: FUNCTION ensure_initial_strategy_backtest(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.ensure_initial_strategy_backtest() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_initial_strategy_backtest() TO service_role;


--
-- Name: FUNCTION ensure_paper_shadow_account(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.ensure_paper_shadow_account() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_paper_shadow_account() TO service_role;


--
-- Name: FUNCTION ensure_strategy_shadow(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.ensure_strategy_shadow() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_strategy_shadow() TO service_role;


--
-- Name: FUNCTION finalize_outbox(p_id uuid, p_state text, p_provider_id text, p_error text, p_next_attempt_at timestamp with time zone, p_attempt integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.finalize_outbox(p_id uuid, p_state text, p_provider_id text, p_error text, p_next_attempt_at timestamp with time zone, p_attempt integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_outbox(p_id uuid, p_state text, p_provider_id text, p_error text, p_next_attempt_at timestamp with time zone, p_attempt integer) TO service_role;


--
-- Name: FUNCTION finish_hyperliquid_account_sync(p_user_id uuid, p_succeeded boolean, p_fills_cursor_ms bigint, p_funding_cursor_ms bigint, p_ledger_cursor_ms bigint, p_error text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.finish_hyperliquid_account_sync(p_user_id uuid, p_succeeded boolean, p_fills_cursor_ms bigint, p_funding_cursor_ms bigint, p_ledger_cursor_ms bigint, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_hyperliquid_account_sync(p_user_id uuid, p_succeeded boolean, p_fills_cursor_ms bigint, p_funding_cursor_ms bigint, p_ledger_cursor_ms bigint, p_error text) TO service_role;


--
-- Name: FUNCTION finish_paper_processor_bucket(p_bucket timestamp with time zone, p_state text, p_metrics jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.finish_paper_processor_bucket(p_bucket timestamp with time zone, p_state text, p_metrics jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_paper_processor_bucket(p_bucket timestamp with time zone, p_state text, p_metrics jsonb) TO service_role;


--
-- Name: FUNCTION fixed_alert_delivery(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.fixed_alert_delivery() TO anon;
GRANT ALL ON FUNCTION public.fixed_alert_delivery() TO authenticated;
GRANT ALL ON FUNCTION public.fixed_alert_delivery() TO service_role;


--
-- Name: FUNCTION guard_migrated_alert_rules(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.guard_migrated_alert_rules() TO anon;
GRANT ALL ON FUNCTION public.guard_migrated_alert_rules() TO authenticated;
GRANT ALL ON FUNCTION public.guard_migrated_alert_rules() TO service_role;


--
-- Name: FUNCTION guard_strategy_owned_paper_command(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.guard_strategy_owned_paper_command() TO anon;
GRANT ALL ON FUNCTION public.guard_strategy_owned_paper_command() TO authenticated;
GRANT ALL ON FUNCTION public.guard_strategy_owned_paper_command() TO service_role;


--
-- Name: FUNCTION paper_fee_volume(p_epoch_id uuid, p_now timestamp with time zone); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.paper_fee_volume(p_epoch_id uuid, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.paper_fee_volume(p_epoch_id uuid, p_now timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.paper_fee_volume(p_epoch_id uuid, p_now timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.paper_fee_volume(p_epoch_id uuid, p_now timestamp with time zone) TO service_role;


--
-- Name: FUNCTION paper_funding_exposure(p_epoch_id uuid, p_asset text, p_timestamps timestamp with time zone[]); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.paper_funding_exposure(p_epoch_id uuid, p_asset text, p_timestamps timestamp with time zone[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.paper_funding_exposure(p_epoch_id uuid, p_asset text, p_timestamps timestamp with time zone[]) TO anon;
GRANT ALL ON FUNCTION public.paper_funding_exposure(p_epoch_id uuid, p_asset text, p_timestamps timestamp with time zone[]) TO authenticated;
GRANT ALL ON FUNCTION public.paper_funding_exposure(p_epoch_id uuid, p_asset text, p_timestamps timestamp with time zone[]) TO service_role;


--
-- Name: FUNCTION paper_processor_account_state(p_epoch_id uuid, p_asset text, p_funding_timestamps timestamp with time zone[]); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.paper_processor_account_state(p_epoch_id uuid, p_asset text, p_funding_timestamps timestamp with time zone[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.paper_processor_account_state(p_epoch_id uuid, p_asset text, p_funding_timestamps timestamp with time zone[]) TO service_role;


--
-- Name: FUNCTION paper_processor_risk_state(p_epoch_id uuid, p_asset text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.paper_processor_risk_state(p_epoch_id uuid, p_asset text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.paper_processor_risk_state(p_epoch_id uuid, p_asset text) TO service_role;


--
-- Name: FUNCTION prune_listener_history(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.prune_listener_history() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_listener_history() TO service_role;


--
-- Name: FUNCTION prune_paper_diagnostics(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.prune_paper_diagnostics() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_paper_diagnostics() TO service_role;


--
-- Name: FUNCTION queue_strategy_backtest(p_revision_id uuid, p_assets text[], p_start timestamp with time zone, p_end timestamp with time zone, p_initial_capital numeric); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.queue_strategy_backtest(p_revision_id uuid, p_assets text[], p_start timestamp with time zone, p_end timestamp with time zone, p_initial_capital numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.queue_strategy_backtest(p_revision_id uuid, p_assets text[], p_start timestamp with time zone, p_end timestamp with time zone, p_initial_capital numeric) TO service_role;
GRANT ALL ON FUNCTION public.queue_strategy_backtest(p_revision_id uuid, p_assets text[], p_start timestamp with time zone, p_end timestamp with time zone, p_initial_capital numeric) TO authenticated;


--
-- Name: FUNCTION record_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.record_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb) TO service_role;


--
-- Name: FUNCTION record_asset_price_samples(p_bucket timestamp with time zone, p_samples jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.record_asset_price_samples(p_bucket timestamp with time zone, p_samples jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_asset_price_samples(p_bucket timestamp with time zone, p_samples jsonb) TO service_role;


--
-- Name: FUNCTION record_legacy_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.record_legacy_alert_occurrence(p_rule_id uuid, p_bucket timestamp with time zone, p_mark_price double precision, p_classification text, p_evidence jsonb) FROM PUBLIC;


--
-- Name: FUNCTION reject_strategy_revision_mutation(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.reject_strategy_revision_mutation() TO anon;
GRANT ALL ON FUNCTION public.reject_strategy_revision_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.reject_strategy_revision_mutation() TO service_role;


--
-- Name: FUNCTION rename_paper_account(p_account_id uuid, p_name text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.rename_paper_account(p_account_id uuid, p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rename_paper_account(p_account_id uuid, p_name text) TO service_role;
GRANT ALL ON FUNCTION public.rename_paper_account(p_account_id uuid, p_name text) TO authenticated;


--
-- Name: FUNCTION replace_hyperliquid_account_positions(p_user_id uuid, p_address text, p_observed_at timestamp with time zone, p_positions jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.replace_hyperliquid_account_positions(p_user_id uuid, p_address text, p_observed_at timestamp with time zone, p_positions jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_hyperliquid_account_positions(p_user_id uuid, p_address text, p_observed_at timestamp with time zone, p_positions jsonb) TO service_role;


--
-- Name: FUNCTION require_paper_owner(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.require_paper_owner() FROM PUBLIC;
GRANT ALL ON FUNCTION public.require_paper_owner() TO authenticated;
GRANT ALL ON FUNCTION public.require_paper_owner() TO service_role;


--
-- Name: FUNCTION reset_paper_account(p_account_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.reset_paper_account(p_account_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reset_paper_account(p_account_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.reset_paper_account(p_account_id uuid) TO authenticated;


--
-- Name: FUNCTION revalue_paper_epoch_asset(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_mark_price numeric, p_input_version text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.revalue_paper_epoch_asset(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_mark_price numeric, p_input_version text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revalue_paper_epoch_asset(p_epoch_id uuid, p_expected_version bigint, p_asset text, p_mark_price numeric, p_input_version text) TO service_role;


--
-- Name: FUNCTION set_alert_rule_enabled(p_rule_id uuid, p_enabled boolean); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.set_alert_rule_enabled(p_rule_id uuid, p_enabled boolean) TO anon;
GRANT ALL ON FUNCTION public.set_alert_rule_enabled(p_rule_id uuid, p_enabled boolean) TO authenticated;
GRANT ALL ON FUNCTION public.set_alert_rule_enabled(p_rule_id uuid, p_enabled boolean) TO service_role;


--
-- Name: FUNCTION set_paper_leverage(p_account_id uuid, p_asset text, p_margin_mode text, p_leverage integer, p_isolated_margin numeric); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.set_paper_leverage(p_account_id uuid, p_asset text, p_margin_mode text, p_leverage integer, p_isolated_margin numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_paper_leverage(p_account_id uuid, p_asset text, p_margin_mode text, p_leverage integer, p_isolated_margin numeric) TO service_role;
GRANT ALL ON FUNCTION public.set_paper_leverage(p_account_id uuid, p_asset text, p_margin_mode text, p_leverage integer, p_isolated_margin numeric) TO authenticated;


--
-- Name: FUNCTION set_paper_risk_projection(p_epoch_id uuid, p_expected_version bigint, p_margin_used numeric, p_maintenance_margin numeric); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.set_paper_risk_projection(p_epoch_id uuid, p_expected_version bigint, p_margin_used numeric, p_maintenance_margin numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_paper_risk_projection(p_epoch_id uuid, p_expected_version bigint, p_margin_used numeric, p_maintenance_margin numeric) TO service_role;


--
-- Name: FUNCTION set_strategy_assignment_state(p_assignment_id uuid, p_state text, p_pause_mode text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.set_strategy_assignment_state(p_assignment_id uuid, p_state text, p_pause_mode text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_strategy_assignment_state(p_assignment_id uuid, p_state text, p_pause_mode text) TO service_role;
GRANT ALL ON FUNCTION public.set_strategy_assignment_state(p_assignment_id uuid, p_state text, p_pause_mode text) TO authenticated;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION validate_trade_log_share_balance(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.validate_trade_log_share_balance() FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_trade_log_share_balance() TO service_role;


--
-- Name: TABLE alert_occurrences; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.alert_occurrences TO service_role;
GRANT SELECT ON TABLE public.alert_occurrences TO authenticated;


--
-- Name: TABLE alert_runtime_destination; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.alert_runtime_destination TO anon;
GRANT ALL ON TABLE public.alert_runtime_destination TO authenticated;
GRANT ALL ON TABLE public.alert_runtime_destination TO service_role;


--
-- Name: TABLE asset_analytics_cache; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.asset_analytics_cache TO service_role;
GRANT SELECT ON TABLE public.asset_analytics_cache TO anon;
GRANT SELECT ON TABLE public.asset_analytics_cache TO authenticated;


--
-- Name: TABLE audio_listener_assets; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.audio_listener_assets TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.audio_listener_assets TO authenticated;


--
-- Name: TABLE backtest_equity_points; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.backtest_equity_points TO service_role;
GRANT SELECT ON TABLE public.backtest_equity_points TO authenticated;


--
-- Name: TABLE backtest_runs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.backtest_runs TO service_role;
GRANT SELECT ON TABLE public.backtest_runs TO authenticated;


--
-- Name: TABLE backtest_trades; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.backtest_trades TO service_role;
GRANT SELECT ON TABLE public.backtest_trades TO authenticated;


--
-- Name: TABLE detector_models; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.detector_models TO service_role;


--
-- Name: TABLE hyperliquid_account_fills; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.hyperliquid_account_fills TO service_role;
GRANT SELECT ON TABLE public.hyperliquid_account_fills TO authenticated;


--
-- Name: TABLE hyperliquid_account_funding; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.hyperliquid_account_funding TO service_role;
GRANT SELECT ON TABLE public.hyperliquid_account_funding TO authenticated;


--
-- Name: TABLE hyperliquid_account_ledger; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.hyperliquid_account_ledger TO service_role;
GRANT SELECT ON TABLE public.hyperliquid_account_ledger TO authenticated;


--
-- Name: TABLE hyperliquid_account_position_tags; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.hyperliquid_account_position_tags TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hyperliquid_account_position_tags TO authenticated;


--
-- Name: TABLE hyperliquid_account_positions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.hyperliquid_account_positions TO service_role;
GRANT SELECT ON TABLE public.hyperliquid_account_positions TO authenticated;


--
-- Name: TABLE hyperliquid_account_sources; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.hyperliquid_account_sources TO service_role;
GRANT SELECT ON TABLE public.hyperliquid_account_sources TO authenticated;


--
-- Name: TABLE level_tool_preferences; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.level_tool_preferences TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.level_tool_preferences TO authenticated;


--
-- Name: TABLE market_observations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.market_observations TO service_role;


--
-- Name: TABLE monitor_runs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.monitor_runs TO service_role;
GRANT SELECT ON TABLE public.monitor_runs TO authenticated;


--
-- Name: TABLE new_asset_acknowledgements; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.new_asset_acknowledgements TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.new_asset_acknowledgements TO authenticated;


--
-- Name: TABLE paper_account_epochs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_account_epochs TO service_role;
GRANT SELECT ON TABLE public.paper_account_epochs TO authenticated;


--
-- Name: TABLE paper_account_market_cursors; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_account_market_cursors TO service_role;


--
-- Name: TABLE paper_account_summaries; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_account_summaries TO service_role;
GRANT SELECT ON TABLE public.paper_account_summaries TO authenticated;


--
-- Name: TABLE paper_accounts; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_accounts TO service_role;
GRANT SELECT ON TABLE public.paper_accounts TO authenticated;


--
-- Name: TABLE paper_commands; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_commands TO service_role;
GRANT SELECT ON TABLE public.paper_commands TO authenticated;


--
-- Name: TABLE paper_fills; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_fills TO service_role;
GRANT SELECT ON TABLE public.paper_fills TO authenticated;


--
-- Name: TABLE paper_funding_payments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_funding_payments TO service_role;
GRANT SELECT ON TABLE public.paper_funding_payments TO authenticated;


--
-- Name: TABLE paper_ledger_entries; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_ledger_entries TO service_role;
GRANT SELECT ON TABLE public.paper_ledger_entries TO authenticated;


--
-- Name: TABLE paper_orders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_orders TO service_role;
GRANT SELECT ON TABLE public.paper_orders TO authenticated;


--
-- Name: TABLE paper_ledger_history; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_ledger_history TO service_role;
GRANT SELECT ON TABLE public.paper_ledger_history TO authenticated;


--
-- Name: TABLE paper_leverage_settings; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_leverage_settings TO service_role;
GRANT SELECT ON TABLE public.paper_leverage_settings TO authenticated;


--
-- Name: TABLE paper_liquidations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_liquidations TO service_role;
GRANT SELECT ON TABLE public.paper_liquidations TO authenticated;


--
-- Name: TABLE paper_market_inputs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_market_inputs TO service_role;


--
-- Name: TABLE paper_order_history; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_order_history TO service_role;
GRANT SELECT ON TABLE public.paper_order_history TO authenticated;


--
-- Name: TABLE paper_positions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_positions TO service_role;
GRANT SELECT ON TABLE public.paper_positions TO authenticated;


--
-- Name: TABLE paper_processor_runs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_processor_runs TO service_role;
GRANT SELECT ON TABLE public.paper_processor_runs TO authenticated;


--
-- Name: TABLE paper_processor_health; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_processor_health TO authenticated;
GRANT ALL ON TABLE public.paper_processor_health TO service_role;


--
-- Name: TABLE paper_processor_lease; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.paper_processor_lease TO service_role;


--
-- Name: TABLE price_alert_watchdog; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.price_alert_watchdog TO anon;
GRANT ALL ON TABLE public.price_alert_watchdog TO authenticated;
GRANT ALL ON TABLE public.price_alert_watchdog TO service_role;


--
-- Name: TABLE price_stream_health; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.price_stream_health TO anon;
GRANT ALL ON TABLE public.price_stream_health TO authenticated;
GRANT ALL ON TABLE public.price_stream_health TO service_role;


--
-- Name: TABLE rule_evaluation_state; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.rule_evaluation_state TO service_role;
GRANT SELECT ON TABLE public.rule_evaluation_state TO authenticated;


--
-- Name: TABLE sign_in_email_limits; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.sign_in_email_limits TO service_role;


--
-- Name: TABLE strategy_actions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.strategy_actions TO service_role;
GRANT SELECT ON TABLE public.strategy_actions TO authenticated;


--
-- Name: TABLE strategy_assignments; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.strategy_assignments TO service_role;
GRANT SELECT ON TABLE public.strategy_assignments TO authenticated;


--
-- Name: TABLE strategy_candles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.strategy_candles TO service_role;


--
-- Name: TABLE strategy_definitions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.strategy_definitions TO service_role;
GRANT SELECT ON TABLE public.strategy_definitions TO authenticated;


--
-- Name: TABLE strategy_evaluations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.strategy_evaluations TO service_role;
GRANT SELECT ON TABLE public.strategy_evaluations TO authenticated;


--
-- Name: TABLE strategy_operational_health; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.strategy_operational_health TO service_role;
GRANT SELECT ON TABLE public.strategy_operational_health TO authenticated;


--
-- Name: TABLE strategy_positions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.strategy_positions TO service_role;
GRANT SELECT ON TABLE public.strategy_positions TO authenticated;


--
-- Name: TABLE strategy_revisions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.strategy_revisions TO service_role;
GRANT SELECT ON TABLE public.strategy_revisions TO authenticated;


--
-- Name: TABLE trade_csv_uploads; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.trade_csv_uploads TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.trade_csv_uploads TO authenticated;


--
-- Name: TABLE trade_log_orders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.trade_log_orders TO service_role;
GRANT SELECT,INSERT,DELETE ON TABLE public.trade_log_orders TO authenticated;


--
-- Name: TABLE volatility_states; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.volatility_states TO service_role;


--
-- Name: TABLE watchlist_items; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.watchlist_items TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.watchlist_items TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--



--
-- PostgreSQL database dump complete
--
