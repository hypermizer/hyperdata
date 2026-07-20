create or replace function public.ensure_paper_shadow_account()
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare owner_id uuid;
declare account_id uuid;
declare epoch_id uuid;
begin
  select id into owner_id from auth.users where lower(email) = 'jasonblick@zohomail.com' order by created_at limit 1;
  if owner_id is null then raise exception 'paper owner user does not exist'; end if;
  select id into account_id from public.paper_accounts
  where user_id = owner_id and name = '__SHADOW__ ORCL' and archived_at is null;
  if account_id is not null then return account_id; end if;

  insert into public.paper_accounts (user_id, name) values (owner_id, '__SHADOW__ ORCL') returning id into account_id;
  insert into public.paper_account_epochs (account_id, epoch_number) values (account_id, 1) returning id into epoch_id;
  insert into public.paper_account_summaries (epoch_id) values (epoch_id);
  insert into public.paper_ledger_entries (epoch_id, entry_type, amount) values (epoch_id, 'opening_balance', 5000);
  insert into public.paper_positions (
    epoch_id, asset, margin_mode, signed_size, entry_price, mark_price,
    isolated_margin, input_version
  ) values (epoch_id, 'xyz:ORCL', 'isolated', 0.001, 100, 100, 500, 'shadow-seed-v1');
  insert into public.paper_fills (
    epoch_id, asset, side, liquidity, size, price, fee, source_id,
    source_timestamp, input_version, fidelity
  ) values (
    epoch_id, 'xyz:ORCL', 'buy', 'taker', 0.001, 100, 0,
    'shadow-seed-v1', now(), 'shadow-seed-v1', 'reconciled'
  );
  return account_id;
end;
$$;

revoke all on function public.ensure_paper_shadow_account() from public, anon, authenticated;
grant execute on function public.ensure_paper_shadow_account() to service_role;
