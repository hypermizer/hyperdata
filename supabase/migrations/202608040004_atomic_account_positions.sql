create or replace function public.replace_hyperliquid_account_positions(
  p_user_id uuid,
  p_address text,
  p_observed_at timestamptz,
  p_positions jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.replace_hyperliquid_account_positions(uuid, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.replace_hyperliquid_account_positions(uuid, text, timestamptz, jsonb) to service_role;
