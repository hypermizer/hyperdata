create or replace function public.paper_processor_account_state(
  p_epoch_id uuid,
  p_asset text,
  p_funding_timestamps timestamptz[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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

create or replace function public.paper_processor_risk_state(p_epoch_id uuid, p_asset text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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

create or replace function public.set_paper_risk_projection(
  p_epoch_id uuid,
  p_expected_version bigint,
  p_margin_used numeric,
  p_maintenance_margin numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.paper_processor_account_state(uuid, text, timestamptz[]) from public, anon, authenticated;
revoke all on function public.paper_processor_risk_state(uuid, text) from public, anon, authenticated;
revoke all on function public.set_paper_risk_projection(uuid, bigint, numeric, numeric) from public, anon, authenticated;
grant execute on function public.paper_processor_account_state(uuid, text, timestamptz[]) to service_role;
grant execute on function public.paper_processor_risk_state(uuid, text) to service_role;
grant execute on function public.set_paper_risk_projection(uuid, bigint, numeric, numeric) to service_role;
