begin;
select plan(8);

select has_table('public', 'sign_in_email_limits', 'sign-in email limiter exists');
select is((select relrowsecurity from pg_class where oid = 'public.sign_in_email_limits'::regclass), true, 'sign-in limiter has RLS enabled');
select function_privs_are('public', 'claim_sign_in_email_delivery', array['timestamptz'], 'service_role', array['EXECUTE'], 'only service delivery can claim');
select function_privs_are('public', 'claim_sign_in_email_delivery', array['timestamptz'], 'anon', array[]::text[], 'anonymous users cannot bypass the edge function');

select is(public.claim_sign_in_email_delivery('2026-07-27T00:00:00Z'), 'claimed', 'first request is claimed');
select is(public.claim_sign_in_email_delivery('2026-07-27T00:00:05Z'), 'cooldown', 'rapid repeat is throttled');
select is(public.claim_sign_in_email_delivery('2026-07-27T00:00:11Z'), 'claimed', 'request after cooldown is claimed');

update public.sign_in_email_limits set attempt_count = 100, window_started_at = '2026-07-27T00:00:00Z', last_sent_at = '2026-07-27T00:30:00Z';
select is(public.claim_sign_in_email_delivery('2026-07-27T00:30:11Z'), 'hourly_limit', 'hourly cap is enforced');

select * from finish();
rollback;
