begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000291',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'jasonblick@zohomail.com', '', now(),
  '{}', '{}', now(), now()
);
insert into public.paper_accounts(id, user_id, name) values (
  '00000000-0000-0000-0000-000000000292', '00000000-0000-0000-0000-000000000291', 'Processor state'
);
insert into public.paper_account_epochs(id, account_id, epoch_number, version) values (
  '00000000-0000-0000-0000-000000000293', '00000000-0000-0000-0000-000000000292', 1, 4
);
insert into public.paper_account_summaries(epoch_id, cash_balance, equity) values (
  '00000000-0000-0000-0000-000000000293', 5000, 5010
);
insert into public.paper_positions(epoch_id, asset, margin_mode, signed_size, entry_price, mark_price, input_version) values (
  '00000000-0000-0000-0000-000000000293', 'BTC', 'cross', 1, 100, 110, 'input-v1'
);
insert into public.paper_leverage_settings(epoch_id, asset, leverage) values (
  '00000000-0000-0000-0000-000000000293', 'BTC', 10
);

set local role service_role;
select is((public.paper_processor_account_state('00000000-0000-0000-0000-000000000293', 'BTC', '{}'::timestamptz[]) ->> 'epochVersion')::integer, 4, 'account state carries the guarded epoch version');
select is(jsonb_array_length(public.paper_processor_account_state('00000000-0000-0000-0000-000000000293', 'BTC', '{}'::timestamptz[]) -> 'positions'), 1, 'account state includes positions in one snapshot');
select is(jsonb_typeof(public.paper_processor_account_state('00000000-0000-0000-0000-000000000293', 'BTC', '{}'::timestamptz[]) -> 'positions' -> 0 -> 'signed_size'), 'string', 'position decimals cross the API without binary rounding');
select is((public.paper_processor_risk_state('00000000-0000-0000-0000-000000000293', 'BTC') ->> 'cashBalance')::numeric, 5000::numeric, 'risk state includes current cash');
select ok(public.set_paper_risk_projection('00000000-0000-0000-0000-000000000293', 4, 11, 2), 'matching version updates derived risk');
select is((select margin_used from public.paper_account_summaries where epoch_id = '00000000-0000-0000-0000-000000000293'), 11::numeric, 'derived risk persists');
select isnt(public.set_paper_risk_projection('00000000-0000-0000-0000-000000000293', 3, 99, 99), true, 'stale projection cannot overwrite current risk');

select * from finish();
rollback;
