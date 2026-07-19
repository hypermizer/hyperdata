create table public.paper_processor_lease (
  singleton boolean primary key default true check (singleton),
  bucket timestamptz,
  lease_until timestamptz
);

insert into public.paper_processor_lease (singleton) values (true);
alter table public.paper_processor_lease enable row level security;
revoke all on table public.paper_processor_lease from public, anon, authenticated;
grant all privileges on table public.paper_processor_lease to service_role;

create or replace function public.claim_paper_processor_bucket(p_bucket timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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
  set bucket = p_bucket, lease_until = now() + interval '30 seconds'
  where singleton;
  insert into public.paper_processor_runs (bucket, state, lease_until, lag_seconds)
  values (p_bucket, 'claimed', now() + interval '30 seconds',
    greatest(0, extract(epoch from now() - p_bucket)::integer));
  return true;
end;
$$;

create or replace function public.finish_paper_processor_bucket(
  p_bucket timestamptz,
  p_state text,
  p_metrics jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.claim_paper_processor_bucket(timestamptz) from public, anon, authenticated;
revoke all on function public.finish_paper_processor_bucket(timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_paper_processor_bucket(timestamptz) to service_role;
grant execute on function public.finish_paper_processor_bucket(timestamptz, text, jsonb) to service_role;

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
  update public.paper_account_epochs set version = version + 1 where id = p_epoch_id;
  return true;
end;
$$;

revoke all on function public.revalue_paper_epoch_asset(uuid, bigint, text, numeric, text) from public, anon, authenticated;
grant execute on function public.revalue_paper_epoch_asset(uuid, bigint, text, numeric, text) to service_role;

create or replace function public.apply_paper_replay_effect(
  p_epoch_id uuid,
  p_expected_version bigint,
  p_effects jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare epoch_row public.paper_account_epochs%rowtype;
declare order_row public.paper_orders%rowtype;
declare total_fee numeric(38, 6) := 0;
declare total_realized numeric(38, 6) := coalesce((p_effects ->> 'realizedPnl')::numeric, 0);
declare total_volume numeric(38, 6) := 0;
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
    fidelity = 'trade_replay',
    source_timestamp = (p_effects ->> 'sourceTimestamp')::timestamptz,
    updated_at = now()
  where id = order_row.id;

  insert into public.paper_fills (
    epoch_id, order_id, asset, side, liquidity, size, price, fee,
    source_id, source_timestamp, input_version, fidelity
  ) select p_epoch_id, order_row.id, order_row.asset, order_row.side,
    fill.liquidity, fill.size::numeric, fill.price::numeric, fill.fee::numeric,
    fill."sourceId", (p_effects ->> 'sourceTimestamp')::timestamptz,
    p_effects ->> 'inputVersion', 'trade_replay'
  from jsonb_to_recordset(coalesce(p_effects -> 'fills', '[]'::jsonb))
    as fill(price text, size text, fee text, liquidity text, "sourceId" text)
  on conflict (epoch_id, source_id) do nothing;

  select coalesce(sum((fill ->> 'fee')::numeric), 0),
    coalesce(sum((fill ->> 'size')::numeric * (fill ->> 'price')::numeric), 0)
  into total_fee, total_volume
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

revoke all on function public.apply_paper_replay_effect(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.apply_paper_replay_effect(uuid, bigint, jsonb) to service_role;

create or replace function public.configure_paper_cron(p_enabled boolean default false)
returns void
language plpgsql
security definer
set search_path = public, cron, vault
as $$
declare project_url text;
declare service_key text;
declare scheduler_secret text;
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'hyperdata-process-paper';
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
$$;

revoke all on function public.configure_paper_cron(boolean) from public, anon, authenticated;
grant execute on function public.configure_paper_cron(boolean) to service_role;
