create or replace function public.configure_paper_mutation_access(p_enabled boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_enabled then
    grant execute on function public.create_paper_account(text) to authenticated;
    grant execute on function public.rename_paper_account(uuid, text) to authenticated;
    grant execute on function public.archive_paper_account(uuid) to authenticated;
    grant execute on function public.reset_paper_account(uuid) to authenticated;
    grant execute on function public.set_paper_leverage(uuid, text, text, integer, numeric) to authenticated;
    grant execute on function public.cancel_paper_order(uuid, uuid) to authenticated;
  else
    revoke execute on function public.create_paper_account(text) from authenticated;
    revoke execute on function public.rename_paper_account(uuid, text) from authenticated;
    revoke execute on function public.archive_paper_account(uuid) from authenticated;
    revoke execute on function public.reset_paper_account(uuid) from authenticated;
    revoke execute on function public.set_paper_leverage(uuid, text, text, integer, numeric) from authenticated;
    revoke execute on function public.cancel_paper_order(uuid, uuid) from authenticated;
  end if;
end;
$$;

revoke all on function public.configure_paper_mutation_access(boolean) from public, anon, authenticated;
grant execute on function public.configure_paper_mutation_access(boolean) to service_role;
select public.configure_paper_mutation_access(false);
