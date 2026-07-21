create or replace function public.guard_strategy_owned_paper_command()
returns trigger language plpgsql security definer set search_path=public as $$
declare command_asset text;
begin
  command_asset := new.canonical_result->'order'->>'asset';
  if command_asset is null or new.idempotency_key like 'strategy:%' then return new; end if;
  if exists(
    select 1 from public.strategy_assignments a
    where a.epoch_id=new.epoch_id and a.asset=command_asset and a.state <> 'paused'
  ) then raise exception using errcode='P0001', message='asset is controlled by an enabled strategy; pause it before placing a manual order';
  end if;
  return new;
end $$;

create trigger paper_commands_strategy_owner_guard before insert on public.paper_commands
for each row execute function public.guard_strategy_owned_paper_command();

create or replace function public.disable_reset_epoch_strategies()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if old.state='active' and new.state='closed' then
    update public.strategy_assignments set state='paused',degraded_reason='account_epoch_reset' where epoch_id=new.id;
  end if;
  return new;
end $$;

create trigger paper_epoch_reset_disables_strategies after update of state on public.paper_account_epochs
for each row execute function public.disable_reset_epoch_strategies();
