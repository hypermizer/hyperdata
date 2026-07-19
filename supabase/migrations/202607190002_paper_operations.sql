create or replace function public.require_paper_owner()
returns uuid
language plpgsql
stable
security invoker
set search_path = public, auth
as $$
begin
  if auth.uid() is null or auth.jwt() ->> 'email' <> 'jasonblick@zohomail.com' then
    raise exception 'not authorized';
  end if;
  return auth.uid();
end;
$$;

create or replace function public.create_paper_account(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  owner_id uuid := public.require_paper_owner();
  account_id uuid;
  epoch_id uuid;
begin
  insert into public.paper_accounts (user_id, name)
  values (owner_id, trim(p_name))
  returning id into account_id;

  insert into public.paper_account_epochs (account_id, epoch_number)
  values (account_id, 1)
  returning id into epoch_id;

  insert into public.paper_account_summaries (epoch_id) values (epoch_id);
  insert into public.paper_ledger_entries (epoch_id, entry_type, amount)
  values (epoch_id, 'opening_balance', 5000.000000);

  return account_id;
end;
$$;

create or replace function public.rename_paper_account(p_account_id uuid, p_name text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
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

create or replace function public.archive_paper_account(p_account_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
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

create or replace function public.reset_paper_account(p_account_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  next_epoch integer;
  old_epoch_id uuid;
  new_epoch_id uuid;
begin
  perform public.require_paper_owner();
  select active_epoch into next_epoch
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
  insert into public.paper_account_summaries (epoch_id) values (new_epoch_id);
  insert into public.paper_ledger_entries (epoch_id, entry_type, amount)
  values (new_epoch_id, 'opening_balance', 5000.000000);
  return next_epoch;
end;
$$;

create or replace function public.apply_paper_effects(
  p_account_id uuid,
  p_epoch_number integer,
  p_expected_version bigint,
  p_idempotency_key text,
  p_effects jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  epoch_row public.paper_account_epochs%rowtype;
  stored_result jsonb;
  cash_delta numeric(38, 6);
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

  select coalesce(sum((entry ->> 'amount')::numeric), 0) into cash_delta
  from jsonb_array_elements(coalesce(p_effects -> 'ledger', '[]'::jsonb)) entry;
  update public.paper_account_summaries
  set cash_balance = cash_balance + cash_delta,
      equity = equity + cash_delta,
      withdrawable = withdrawable + cash_delta,
      reconciled_at = now()
  where epoch_id = epoch_row.id;
  update public.paper_account_epochs set version = version + 1 where id = epoch_row.id;
  return p_effects;
end;
$$;

revoke all on function public.require_paper_owner() from public, anon;
revoke all on function public.create_paper_account(text) from public, anon;
revoke all on function public.rename_paper_account(uuid, text) from public, anon;
revoke all on function public.archive_paper_account(uuid) from public, anon;
revoke all on function public.reset_paper_account(uuid) from public, anon;
revoke all on function public.apply_paper_effects(uuid, integer, bigint, text, jsonb) from public, anon, authenticated;

grant execute on function public.require_paper_owner() to authenticated;
grant execute on function public.create_paper_account(text) to authenticated;
grant execute on function public.rename_paper_account(uuid, text) to authenticated;
grant execute on function public.archive_paper_account(uuid) to authenticated;
grant execute on function public.reset_paper_account(uuid) to authenticated;
grant execute on function public.apply_paper_effects(uuid, integer, bigint, text, jsonb) to service_role;
