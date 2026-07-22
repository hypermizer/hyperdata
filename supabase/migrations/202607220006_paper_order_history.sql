create or replace view public.paper_order_history
with (security_invoker = true)
as
with fill_totals as (
  select
    fill.epoch_id,
    fill.order_id,
    sum(fill.size)::numeric(38, 12) as filled_size,
    (sum(fill.size * fill.price) / nullif(sum(fill.size), 0))::numeric(38, 12) as entry_price,
    sum(fill.size * fill.price)::numeric(38, 12) as notional,
    sum(fill.fee)::numeric(38, 6) as fees
  from public.paper_fills fill
  where fill.order_id is not null
  group by fill.epoch_id, fill.order_id
)
select
  orders.id,
  orders.epoch_id,
  orders.asset,
  orders.side,
  orders.order_type,
  orders.time_in_force,
  orders.margin_mode,
  orders.leverage,
  orders.size as requested_size,
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
  coalesce(orders.source_timestamp, orders.created_at) as event_at,
  fills.filled_size,
  fills.entry_price,
  fills.notional,
  fills.fees
from public.paper_orders orders
left join fill_totals fills
  on fills.order_id = orders.id
  and fills.epoch_id = orders.epoch_id;

comment on view public.paper_order_history is
  'Owner-scoped paper order history with requested and filled size, execution VWAP, notional, and fees.';

revoke all on table public.paper_order_history from public, anon, authenticated;
grant select on table public.paper_order_history to authenticated, service_role;
