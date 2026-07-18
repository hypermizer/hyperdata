begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

insert into public.calibration_jobs (asset, horizon_minutes, state, available_at)
values ('xyz:ORCL', 5, 'complete', now() - interval '1 minute');

select is((select count(*)::integer from public.claim_calibration_jobs(1)), 1, 'claims a due completed calibration for refresh');
select is((select state from public.calibration_jobs where asset = 'xyz:ORCL' and horizon_minutes = 5), 'claimed', 'refresh job is leased');
select ok((select lease_until > now() from public.calibration_jobs where asset = 'xyz:ORCL' and horizon_minutes = 5), 'refresh lease is in the future');

select * from finish();
rollback;
