create or replace function public.prune_listener_history()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  observation_count integer;
  run_count integer;
  model_count integer;
begin
  delete from public.market_observations where bucket < now() - interval '30 days';
  get diagnostics observation_count = row_count;
  delete from public.monitor_runs where bucket < now() - interval '14 days';
  get diagnostics run_count = row_count;
  delete from public.detector_models where expires_at < now() - interval '30 days';
  get diagnostics model_count = row_count;
  return jsonb_build_object('observations', observation_count, 'runs', run_count, 'models', model_count);
end;
$$;

revoke all on function public.prune_listener_history() from public, anon, authenticated;
grant execute on function public.prune_listener_history() to service_role;
