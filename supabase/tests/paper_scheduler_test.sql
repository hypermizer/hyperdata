begin;
select plan(9);

select has_table('public', 'paper_processor_lease', 'processor lease exists');
select function_privs_are('public', 'claim_paper_processor_bucket', array['timestamptz'], 'service_role', array['EXECUTE'], 'service can claim');
select function_privs_are('public', 'claim_paper_processor_bucket', array['timestamptz'], 'authenticated', array[]::text[], 'user cannot claim');

set local role service_role;
select ok(public.claim_paper_processor_bucket('2026-07-19 20:00:00+00'), 'first bucket claims');
select isnt(public.claim_paper_processor_bucket('2026-07-19 20:00:10+00'), true, 'overlap cannot claim');
select is((select state from public.paper_processor_runs where bucket = '2026-07-19 20:00:10+00'), 'overlap', 'overlap is visible');
select lives_ok($$select public.finish_paper_processor_bucket('2026-07-19 20:00:00+00', 'succeeded', '{"assetsProcessed":2,"apiWeight":44}'::jsonb)$$, 'holder finishes');
select is((select assets_processed from public.paper_processor_runs where bucket = '2026-07-19 20:00:00+00'), 2, 'metrics persist');
select isnt(public.claim_paper_processor_bucket('2026-07-19 20:00:00+00'), true, 'completed bucket is idempotent');

select * from finish();
rollback;
