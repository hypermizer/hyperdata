begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select has_function('public', 'prune_paper_diagnostics', array[]::text[], 'diagnostic prune exists');
select function_privs_are('public', 'prune_paper_diagnostics', array[]::text[], 'service_role', array['EXECUTE'], 'service can prune diagnostics');
select function_privs_are('public', 'prune_paper_diagnostics', array[]::text[], 'authenticated', array[]::text[], 'user cannot prune diagnostics');
select has_view('public', 'paper_processor_health', 'processor health view exists');

insert into public.paper_market_inputs (asset, input_kind, input_version, source_timestamp, payload, fidelity, created_at)
values ('ORCL', 'context', 'expired', now() - interval '8 days', '{}'::jsonb, 'live', now() - interval '8 days');
insert into public.paper_processor_runs (bucket, state, finished_at)
values (date_trunc('second', now() - interval '31 days'), 'succeeded', now() - interval '31 days');

set local role service_role;
select is((public.prune_paper_diagnostics() ->> 'marketInputs')::integer, 1, 'expired raw inputs prune');
select is((public.prune_paper_diagnostics() ->> 'marketInputs')::integer, 0, 'prune is idempotent');
select is((select count(*)::integer from public.paper_processor_runs where bucket < now() - interval '30 days'), 0, 'expired runs prune');

select * from finish();
rollback;
