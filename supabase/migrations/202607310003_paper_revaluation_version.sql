create or replace function public.revalue_paper_epoch_asset(
  p_epoch_id uuid,
  p_expected_version bigint,
  p_asset text,
  p_mark_price numeric,
  p_input_version text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.revalue_paper_epoch_asset(uuid, bigint, text, numeric, text) from public, anon, authenticated;
grant execute on function public.revalue_paper_epoch_asset(uuid, bigint, text, numeric, text) to service_role;
