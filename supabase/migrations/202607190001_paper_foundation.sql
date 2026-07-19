create table public.paper_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  active_epoch integer not null default 1 check (active_epoch > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index paper_accounts_active_name_uidx
on public.paper_accounts (user_id, lower(trim(name)))
where archived_at is null;

create trigger paper_accounts_set_updated_at
before update on public.paper_accounts
for each row execute function public.set_updated_at();

create table public.paper_account_epochs (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.paper_accounts (id) on delete cascade,
  epoch_number integer not null check (epoch_number > 0),
  state text not null default 'active' check (state in ('active', 'closed')),
  version bigint not null default 0 check (version >= 0),
  opening_balance numeric(38, 6) not null default 5000.000000 check (opening_balance = 5000.000000),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closing_summary jsonb,
  unique (account_id, epoch_number)
);

create unique index paper_account_epochs_one_active_idx
on public.paper_account_epochs (account_id)
where state = 'active';

create table public.paper_account_summaries (
  epoch_id uuid primary key references public.paper_account_epochs (id) on delete cascade,
  cash_balance numeric(38, 6) not null default 5000.000000,
  equity numeric(38, 6) not null default 5000.000000,
  withdrawable numeric(38, 6) not null default 5000.000000,
  margin_used numeric(38, 6) not null default 0 check (margin_used >= 0),
  maintenance_margin numeric(38, 6) not null default 0 check (maintenance_margin >= 0),
  total_notional numeric(38, 6) not null default 0 check (total_notional >= 0),
  unrealized_pnl numeric(38, 6) not null default 0,
  realized_pnl numeric(38, 6) not null default 0,
  cumulative_funding numeric(38, 6) not null default 0,
  cumulative_fees numeric(38, 6) not null default 0 check (cumulative_fees >= 0),
  trailing_volume numeric(38, 6) not null default 0 check (trailing_volume >= 0),
  fidelity text not null default 'reconciled' check (fidelity in ('reconciled', 'live', 'degraded')),
  reconciled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger paper_account_summaries_set_updated_at
before update on public.paper_account_summaries
for each row execute function public.set_updated_at();

create table public.paper_leverage_settings (
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  asset text not null check (asset ~ '^[a-zA-Z0-9_.:-]+$'),
  margin_mode text not null default 'cross' check (margin_mode in ('cross', 'isolated')),
  leverage integer not null check (leverage > 0),
  isolated_margin numeric(38, 6) check (isolated_margin is null or isolated_margin >= 0),
  updated_at timestamptz not null default now(),
  primary key (epoch_id, asset)
);

create table public.paper_positions (
  id uuid primary key default extensions.gen_random_uuid(),
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  asset text not null check (asset ~ '^[a-zA-Z0-9_.:-]+$'),
  margin_mode text not null check (margin_mode in ('cross', 'isolated')),
  signed_size numeric(38, 12) not null check (signed_size <> 0),
  entry_price numeric(38, 12) not null check (entry_price > 0),
  mark_price numeric(38, 12) not null check (mark_price > 0),
  isolated_margin numeric(38, 6) check (isolated_margin is null or isolated_margin >= 0),
  realized_pnl numeric(38, 6) not null default 0,
  cumulative_funding numeric(38, 6) not null default 0,
  input_version text not null,
  updated_at timestamptz not null default now(),
  unique (epoch_id, asset)
);

create table public.paper_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  client_order_id text not null,
  asset text not null check (asset ~ '^[a-zA-Z0-9_.:-]+$'),
  side text not null check (side in ('buy', 'sell')),
  order_type text not null check (order_type in ('market', 'limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit')),
  time_in_force text check (time_in_force is null or time_in_force in ('GTC', 'ALO', 'IOC')),
  margin_mode text not null check (margin_mode in ('cross', 'isolated')),
  size numeric(38, 12) not null check (size > 0),
  remaining_size numeric(38, 12) not null check (remaining_size >= 0 and remaining_size <= size),
  limit_price numeric(38, 12) check (limit_price is null or limit_price > 0),
  trigger_price numeric(38, 12) check (trigger_price is null or trigger_price > 0),
  reduce_only boolean not null default false,
  status text not null check (status in ('resting', 'trigger_waiting', 'partially_filled', 'filled', 'canceled', 'rejected')),
  parent_order_id uuid references public.paper_orders (id),
  queue_ahead numeric(38, 12) check (queue_ahead is null or queue_ahead >= 0),
  reserved_margin numeric(38, 6) not null default 0 check (reserved_margin >= 0),
  rejection_reason text,
  fidelity text not null,
  source_timestamp timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (epoch_id, client_order_id)
);

create index paper_orders_active_idx on public.paper_orders (epoch_id, asset, status)
where status in ('resting', 'trigger_waiting', 'partially_filled');

create table public.paper_fills (
  id uuid primary key default extensions.gen_random_uuid(),
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  order_id uuid references public.paper_orders (id),
  asset text not null,
  side text not null check (side in ('buy', 'sell')),
  liquidity text not null check (liquidity in ('maker', 'taker', 'liquidation')),
  size numeric(38, 12) not null check (size > 0),
  price numeric(38, 12) not null check (price > 0),
  fee numeric(38, 6) not null check (fee >= 0),
  source_id text not null,
  source_timestamp timestamptz not null,
  input_version text not null,
  fidelity text not null,
  created_at timestamptz not null default now(),
  unique (epoch_id, source_id)
);

create table public.paper_ledger_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  entry_type text not null check (entry_type in ('opening_balance', 'realized_pnl', 'fee', 'funding', 'isolated_transfer', 'liquidation', 'reset_close')),
  amount numeric(38, 6) not null,
  asset text,
  reference_id uuid,
  source_timestamp timestamptz,
  created_at timestamptz not null default now()
);

create index paper_ledger_entries_epoch_idx on public.paper_ledger_entries (epoch_id, created_at);

create table public.paper_funding_payments (
  id uuid primary key default extensions.gen_random_uuid(),
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  asset text not null,
  funding_timestamp timestamptz not null,
  signed_size numeric(38, 12) not null,
  oracle_price numeric(38, 12) not null check (oracle_price > 0),
  funding_rate numeric(38, 18) not null,
  payment numeric(38, 6) not null,
  input_version text not null,
  created_at timestamptz not null default now(),
  unique (epoch_id, asset, funding_timestamp)
);

create table public.paper_liquidations (
  id uuid primary key default extensions.gen_random_uuid(),
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  asset text,
  classification text not null check (classification in ('partial', 'book', 'backstop')),
  trigger_snapshot jsonb not null,
  attempted_fills jsonb not null default '[]'::jsonb,
  maintenance_margin numeric(38, 6) not null check (maintenance_margin >= 0),
  remaining_equity numeric(38, 6) not null,
  cooldown_until timestamptz,
  source_timestamp timestamptz not null,
  input_version text not null,
  created_at timestamptz not null default now()
);

create table public.paper_commands (
  id uuid primary key default extensions.gen_random_uuid(),
  epoch_id uuid not null references public.paper_account_epochs (id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  expected_version bigint not null check (expected_version >= 0),
  canonical_result jsonb not null,
  created_at timestamptz not null default now(),
  unique (epoch_id, idempotency_key)
);

create table public.paper_market_inputs (
  asset text not null,
  input_kind text not null check (input_kind in ('metadata', 'context', 'book', 'trades', 'funding', 'fees')),
  input_version text not null,
  source_timestamp timestamptz not null,
  payload jsonb not null,
  fidelity text not null,
  gap_state text,
  created_at timestamptz not null default now(),
  primary key (asset, input_kind, input_version)
);

create table public.paper_processor_runs (
  bucket timestamptz primary key,
  state text not null check (state in ('claimed', 'succeeded', 'partial', 'failed', 'overlap')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  lease_until timestamptz,
  assets_processed integer not null default 0 check (assets_processed >= 0),
  accounts_processed integer not null default 0 check (accounts_processed >= 0),
  api_weight integer not null default 0 check (api_weight >= 0),
  projected_invocations integer,
  lag_seconds integer,
  reconciliation_failures integer not null default 0 check (reconciliation_failures >= 0),
  details jsonb not null default '{}'::jsonb
);

alter table public.paper_accounts enable row level security;
alter table public.paper_account_epochs enable row level security;
alter table public.paper_account_summaries enable row level security;
alter table public.paper_leverage_settings enable row level security;
alter table public.paper_positions enable row level security;
alter table public.paper_orders enable row level security;
alter table public.paper_fills enable row level security;
alter table public.paper_ledger_entries enable row level security;
alter table public.paper_funding_payments enable row level security;
alter table public.paper_liquidations enable row level security;
alter table public.paper_commands enable row level security;
alter table public.paper_market_inputs enable row level security;
alter table public.paper_processor_runs enable row level security;

create policy "Owner reads paper accounts" on public.paper_accounts for select to authenticated
using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');

create policy "Owner reads paper epochs" on public.paper_account_epochs for select to authenticated
using (exists (select 1 from public.paper_accounts a where a.id = account_id and a.user_id = auth.uid() and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'));

create policy "Owner reads paper summaries" on public.paper_account_summaries for select to authenticated
using (exists (select 1 from public.paper_account_epochs e join public.paper_accounts a on a.id = e.account_id where e.id = epoch_id and a.user_id = auth.uid() and auth.jwt() ->> 'email' = 'jasonblick@zohomail.com'));

do $$
declare table_name text;
begin
  foreach table_name in array array['paper_leverage_settings','paper_positions','paper_orders','paper_fills','paper_ledger_entries','paper_funding_payments','paper_liquidations','paper_commands']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (exists (select 1 from public.paper_account_epochs e join public.paper_accounts a on a.id = e.account_id where e.id = epoch_id and a.user_id = auth.uid() and auth.jwt() ->> ''email'' = ''jasonblick@zohomail.com''))',
      'Owner reads ' || table_name, table_name
    );
  end loop;
end;
$$;

create policy "Owner reads paper processor health" on public.paper_processor_runs for select to authenticated
using (auth.jwt() ->> 'email' = 'jasonblick@zohomail.com');

revoke all on table public.paper_accounts, public.paper_account_epochs, public.paper_account_summaries,
  public.paper_leverage_settings, public.paper_positions, public.paper_orders, public.paper_fills,
  public.paper_ledger_entries, public.paper_funding_payments, public.paper_liquidations,
  public.paper_commands, public.paper_market_inputs, public.paper_processor_runs
from anon, authenticated;

grant select on table public.paper_accounts, public.paper_account_epochs, public.paper_account_summaries,
  public.paper_leverage_settings, public.paper_positions, public.paper_orders, public.paper_fills,
  public.paper_ledger_entries, public.paper_funding_payments, public.paper_liquidations,
  public.paper_commands, public.paper_processor_runs
to authenticated;

grant all privileges on table public.paper_accounts, public.paper_account_epochs, public.paper_account_summaries,
  public.paper_leverage_settings, public.paper_positions, public.paper_orders, public.paper_fills,
  public.paper_ledger_entries, public.paper_funding_payments, public.paper_liquidations,
  public.paper_commands, public.paper_market_inputs, public.paper_processor_runs
to service_role;
