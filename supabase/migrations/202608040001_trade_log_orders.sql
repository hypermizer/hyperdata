create table if not exists public.trade_log_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  asset text not null check (char_length(asset) between 1 and 80),
  side text not null check (side in ('buy', 'sell')),
  shares numeric not null check (shares > 0),
  price numeric not null check (price > 0),
  executed_at timestamptz not null,
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists trade_log_orders_user_execution_idx
on public.trade_log_orders (user_id, executed_at, created_at, id);

create or replace function public.validate_trade_log_share_balance()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
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

drop trigger if exists validate_trade_log_share_balance on public.trade_log_orders;
create trigger validate_trade_log_share_balance
after insert or delete on public.trade_log_orders
for each row execute function public.validate_trade_log_share_balance();

alter table public.trade_log_orders enable row level security;

drop policy if exists "Users manage their own trade log" on public.trade_log_orders;
create policy "Users manage their own trade log"
on public.trade_log_orders
for all
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'
)
with check (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'
);

revoke all on table public.trade_log_orders from anon, authenticated;
grant select, insert, delete on table public.trade_log_orders to authenticated;
grant all privileges on table public.trade_log_orders to service_role;
revoke all on function public.validate_trade_log_share_balance() from public, anon, authenticated;
grant execute on function public.validate_trade_log_share_balance() to service_role;
