create or replace view public.paper_ledger_history
with (security_invoker = true)
as
select
  ledger.id,
  ledger.epoch_id,
  ledger.entry_type,
  ledger.amount,
  ledger.asset,
  ledger.reference_id,
  ledger.source_timestamp,
  ledger.created_at,
  coalesce(ledger.source_timestamp, ledger.created_at) as event_at,
  case
    when ledger.asset is null then null
    when ledger.entry_type = 'funding' then funding.oracle_price
    else fills.execution_price
  end::numeric(38, 12) as asset_price
from public.paper_ledger_entries ledger
left join lateral (
  select payment.oracle_price
  from public.paper_funding_payments payment
  where payment.id = ledger.reference_id
    and payment.epoch_id = ledger.epoch_id
    and payment.asset = ledger.asset
  limit 1
) funding on ledger.entry_type = 'funding'
left join lateral (
  select sum(fill.size * fill.price) / nullif(sum(fill.size), 0) as execution_price
  from public.paper_fills fill
  where fill.epoch_id = ledger.epoch_id
    and fill.asset = ledger.asset
    and fill.source_timestamp = ledger.source_timestamp
    and (
      fill.order_id = ledger.reference_id
      or (
        not exists (
          select 1 from public.paper_orders referenced_order
          where referenced_order.id = ledger.reference_id
            and referenced_order.epoch_id = ledger.epoch_id
        )
        and fill.created_at = (
          select nearest_fill.created_at
          from public.paper_fills nearest_fill
          where nearest_fill.epoch_id = ledger.epoch_id
            and nearest_fill.asset = ledger.asset
            and nearest_fill.source_timestamp = ledger.source_timestamp
          order by abs(extract(epoch from (nearest_fill.created_at - ledger.created_at)))
          limit 1
        )
      )
    )
) fills on ledger.entry_type <> 'funding' and ledger.asset is not null;

comment on view public.paper_ledger_history is
  'Owner-scoped paper ledger history with source event time and event price: execution VWAP for fill-derived entries and oracle price for funding.';

revoke all on table public.paper_ledger_history from public, anon, authenticated;
grant select on table public.paper_ledger_history to authenticated, service_role;
