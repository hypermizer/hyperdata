begin;
select plan(26);

select has_table('public', 'paper_processor_lease', 'processor lease exists');
select has_table('public', 'paper_account_market_cursors', 'per-account market cursors exist');
select function_privs_are('public', 'claim_paper_processor_bucket', array['timestamptz'], 'service_role', array['EXECUTE'], 'service can claim');
select function_privs_are('public', 'claim_paper_processor_bucket', array['timestamptz'], 'authenticated', array[]::text[], 'user cannot claim');

set local role service_role;
select ok(public.claim_paper_processor_bucket('2026-07-19 20:00:00+00'), 'first bucket claims');
select ok((select lease_until >= now() + interval '80 seconds' from public.paper_processor_lease where singleton), 'lease outlives the processor deadline and next schedule');
select isnt(public.claim_paper_processor_bucket('2026-07-19 20:00:10+00'), true, 'overlap cannot claim');
select is((select state from public.paper_processor_runs where bucket = '2026-07-19 20:00:10+00'), 'overlap', 'overlap is visible');
select lives_ok($$select public.finish_paper_processor_bucket('2026-07-19 20:00:00+00', 'succeeded', '{"assetsProcessed":2,"apiWeight":44}'::jsonb)$$, 'holder finishes');
select is((select assets_processed from public.paper_processor_runs where bucket = '2026-07-19 20:00:00+00'), 2, 'metrics persist');
select isnt(public.claim_paper_processor_bucket('2026-07-19 20:00:00+00'), true, 'completed bucket is idempotent');
select function_privs_are('public', 'revalue_paper_epoch_asset', array['uuid','bigint','text','numeric','text'], 'service_role', array['EXECUTE'], 'service can revalue');
select function_privs_are('public', 'revalue_paper_epoch_asset', array['uuid','bigint','text','numeric','text'], 'authenticated', array[]::text[], 'user cannot revalue');
select function_privs_are('public', 'apply_paper_account_snapshot', array['uuid','bigint','text','jsonb','jsonb','numeric','text','jsonb'], 'service_role', array['EXECUTE'], 'service can atomically apply account snapshots');
select function_privs_are('public', 'apply_paper_account_snapshot', array['uuid','bigint','text','jsonb','jsonb','numeric','text','jsonb'], 'authenticated', array[]::text[], 'user cannot apply account snapshots');
select function_privs_are('public', 'configure_paper_cron', array['boolean'], 'service_role', array['EXECUTE'], 'service can configure paper cron');
select function_privs_are('public', 'configure_paper_cron', array['boolean'], 'authenticated', array[]::text[], 'user cannot configure paper cron');
select ok(pg_get_functiondef('public.configure_paper_cron(boolean)'::regprocedure) like '%''10 seconds''%', 'paper processor retains ten-second cadence');
select function_privs_are('public', 'paper_processor_account_state', array['uuid','text','timestamptz[]'], 'service_role', array['EXECUTE'], 'service can load one processor state snapshot');
select function_privs_are('public', 'paper_processor_account_state', array['uuid','text','timestamptz[]'], 'authenticated', array[]::text[], 'user cannot load processor state');
select function_privs_are('public', 'paper_processor_risk_state', array['uuid','text'], 'service_role', array['EXECUTE'], 'service can load one risk snapshot');
select function_privs_are('public', 'paper_processor_risk_state', array['uuid','text'], 'authenticated', array[]::text[], 'user cannot load risk state');
select function_privs_are('public', 'set_paper_risk_projection', array['uuid','bigint','numeric','numeric'], 'service_role', array['EXECUTE'], 'service can persist guarded risk projection');
select function_privs_are('public', 'set_paper_risk_projection', array['uuid','bigint','numeric','numeric'], 'authenticated', array[]::text[], 'user cannot persist risk projection');
select has_column('public', 'paper_processor_health', 'latest_state', 'processor health exposes the latest state');
select is((select latest_state from public.paper_processor_health), 'overlap', 'processor health reports the newest run state');

select * from finish();
rollback;
