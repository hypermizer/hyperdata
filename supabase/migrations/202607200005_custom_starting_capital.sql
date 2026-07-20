alter table public.paper_accounts
  add column starting_capital numeric(38, 6) not null default 5000.000000;

alter table public.paper_accounts
  add constraint paper_accounts_starting_capital_check
  check (starting_capital > 0 and starting_capital <= 1000000000);

drop function public.create_paper_account(text);

create function public.create_paper_account(
  p_name text,
  p_starting_capital numeric default 5000.000000
)
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

create or replace function public.configure_paper_mutation_access(p_enabled boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function public.create_paper_account(text, numeric) from public, anon, authenticated;
