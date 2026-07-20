begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000181',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(),
  '{}', '{}', now(), now()
);

set local role service_role;
select isnt(public.ensure_paper_shadow_account(), null::uuid, 'shadow account seeds');
select is(public.ensure_paper_shadow_account(), (select id from public.paper_accounts where name = '__SHADOW__ ORCL'), 'shadow seed is idempotent');
select is((select count(*)::integer from public.paper_accounts where name = '__SHADOW__ ORCL'), 1, 'only one shadow account exists');
select is((select opening_balance::text from public.paper_account_epochs), '5000.000000', 'shadow starts at five thousand dollars');
select is((select asset from public.paper_positions), 'xyz:ORCL', 'HIP-3 shadow position uses canonical asset');
select function_privs_are('public', 'ensure_paper_shadow_account', array[]::text[], 'authenticated', array[]::text[], 'user cannot create shadow state');

select * from finish();
rollback;
