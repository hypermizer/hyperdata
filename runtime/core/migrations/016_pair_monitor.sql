create table public.pair_trades (
 id uuid primary key default extensions.gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 config jsonb not null check(jsonb_typeof(config)='object' and octet_length(config::text)<=8192),
 archived boolean not null default false,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table pair_trades enable row level security;
revoke all on pair_trades from public,anon,authenticated,service_role;
grant select,insert,update,delete on pair_trades to authenticated;
grant select on pair_trades to service_role;
create policy owner_pair_trades on pair_trades to authenticated using(auth.uid()=user_id and auth.jwt()->>'email'='jasonblick@zohomail.com') with check(auth.uid()=user_id and auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy service_pair_trades on pair_trades to service_role using(true);

create table public.pair_live_accounts (
 user_id uuid not null, dex text not null, observed_at timestamptz not null,
 positions jsonb not null, summary jsonb not null, primary key(user_id,dex)
);
alter table pair_live_accounts enable row level security;
revoke all on pair_live_accounts from public,anon,authenticated,service_role;
grant select on pair_live_accounts to authenticated;
grant all on pair_live_accounts to service_role;
create policy owner_pair_live on pair_live_accounts to authenticated using(auth.uid()=user_id and auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy service_pair_live on pair_live_accounts to service_role using(true) with check(true);
create table public.pair_mark_quotes(asset text primary key,mark_price numeric not null check(mark_price>0),oracle_price numeric,funding_rate numeric,observed_at timestamptz not null);
alter table pair_mark_quotes enable row level security;
revoke all on pair_mark_quotes from public,anon,authenticated,service_role;
grant select on pair_mark_quotes to authenticated;grant all on pair_mark_quotes to service_role;
create policy owner_pair_quotes on pair_mark_quotes to authenticated using(auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy service_pair_quotes on pair_mark_quotes to service_role using(true) with check(true);

create function public.pair_account_snapshot(p_assets text[],p_user uuid default auth.uid()) returns jsonb language plpgsql security invoker set search_path=public as $$
begin
 if current_user<>'service_role' and p_user is distinct from auth.uid() then raise exception 'Owner only';end if;
 if p_assets is null or cardinality(p_assets)<>2 or p_assets[1]=p_assets[2] then raise exception 'Choose two assets'; end if;
 return jsonb_build_object(
 'source',(select to_jsonb(s)-'lease_until' from hyperliquid_account_sources s where s.active and s.user_id=p_user limit 1),
 'positions',coalesce((select jsonb_agg(to_jsonb(p)-'raw') from hyperliquid_account_positions p where user_id=p_user and asset=any(p_assets)),'[]'),
 'live',coalesce((select jsonb_agg(to_jsonb(l)) from pair_live_accounts l where l.user_id=p_user),'[]'),
 'marks',coalesce((select jsonb_agg(to_jsonb(q)) from pair_mark_quotes q where asset=any(p_assets)),'[]'),
 'fills',coalesce((select jsonb_agg(to_jsonb(f)-'raw'-'ingested_at' order by f.occurred_at_ms,f.trade_id) from hyperliquid_account_fills f where user_id=p_user and asset=any(p_assets)),'[]'),
 'funding',coalesce((select jsonb_agg(to_jsonb(f)-'raw'-'ingested_at' order by f.occurred_at_ms) from hyperliquid_account_funding f where user_id=p_user and asset=any(p_assets)),'[]'));
end $$;
revoke all on function pair_account_snapshot(text[],uuid) from public,anon;
grant execute on function pair_account_snapshot(text[],uuid) to authenticated,service_role;

create function public.pair_mark_history(p_assets text[],p_start timestamptz,p_end timestamptz,p_interval integer default 60) returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if (auth.jwt()->>'email') is distinct from 'jasonblick@zohomail.com' or auth.uid() is null then raise exception 'Owner only';end if;
 if p_assets is null or cardinality(p_assets)<>2 or p_start is null or p_end is null or p_interval is null or p_interval<60 or p_interval>86400 or p_start>=p_end or p_end-p_start>interval '400 days' then raise exception 'Invalid history';end if;
 with samples as (
 select distinct on(asset,floor(extract(epoch from observed_at)/p_interval)) asset,floor(extract(epoch from observed_at)/p_interval) as slot,observed_at,price,source
 from mark_price_samples where asset=any(p_assets) and observed_at between p_start and p_end
 order by asset,floor(extract(epoch from observed_at)/p_interval),observed_at desc
 ), paired as (
 select extract(epoch from greatest(a.observed_at,b.observed_at)) as time,a.price as "priceA",b.price as "priceB",a.source as "sourceA",b.source as "sourceB"
 from samples a join samples b using(slot) where a.asset=p_assets[1] and b.asset=p_assets[2] order by time limit 6000)
 select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(paired)),'[]'),'basis','mark') into result from paired;
 return result;
end $$;
revoke all on function pair_mark_history(text[],timestamptz,timestamptz,integer) from public,anon;
grant execute on function pair_mark_history(text[],timestamptz,timestamptz,integer) to authenticated;

create table public.pair_alert_state (
 pair_id uuid not null references pair_trades(id) on delete cascade, metric text not null,
 breached boolean not null default false, last_notice timestamptz, recovery_count integer not null default 0,
 primary key(pair_id,metric)
);
create table public.pair_alert_outbox (
 id uuid primary key default extensions.gen_random_uuid(), pair_id uuid not null references pair_trades(id), user_id uuid not null,
 metric text not null, message text not null,
 state text not null default 'queued' check(state in('queued','claimed','sent','failed')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(), lease_token uuid,lease_until timestamptz,
 created_at timestamptz not null default now(), sent_at timestamptz, last_error text
);
alter table pair_alert_state enable row level security;
alter table pair_alert_outbox enable row level security;
revoke all on pair_alert_state,pair_alert_outbox from public,anon,authenticated,service_role;
grant all on pair_alert_state,pair_alert_outbox to service_role;
grant select on pair_alert_outbox to authenticated;
create policy service_pair_alert_state on pair_alert_state to service_role using(true) with check(true);
create policy service_pair_outbox on pair_alert_outbox to service_role using(true) with check(true);
create policy owner_pair_outbox on pair_alert_outbox to authenticated using(user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com');
create function public.observe_pair_alert(p_pair uuid,p_metric text,p_breached boolean,p_message text) returns boolean language plpgsql security definer set search_path=public as $$
declare r pair_alert_state%rowtype;owner uuid;
begin
 if p_metric not in('profit','loss','exposure','liquidation') then raise exception 'Invalid metric';end if;
 select user_id into owner from pair_trades where id=p_pair and not archived;
 if not found then return false;end if;
 insert into pair_alert_state(pair_id,metric) values(p_pair,p_metric) on conflict do nothing;
 select * into r from pair_alert_state where pair_id=p_pair and metric=p_metric for update;
 if not p_breached then
  update pair_alert_state set recovery_count=least(3,recovery_count+1),breached=case when recovery_count>=2 then false else breached end where pair_id=p_pair and metric=p_metric;
  return false;
 end if;
 update pair_alert_state set recovery_count=0,breached=true where pair_id=p_pair and metric=p_metric;
 if r.breached or r.last_notice>now()-interval '30 minutes' or (select count(*) from pair_alert_outbox where pair_id=p_pair and metric=p_metric and created_at>now()-interval '24 hours')>=4 then return false;end if;
 insert into pair_alert_outbox(pair_id,user_id,metric,message) values(p_pair,owner,p_metric,left(p_message,2000));
 update pair_alert_state set last_notice=now() where pair_id=p_pair and metric=p_metric;
 return true;
end $$;
create function public.claim_pair_alerts() returns setof pair_alert_outbox language sql security definer set search_path=public as $$
 with due as(select id from pair_alert_outbox where (state='queued' and next_attempt_at<=now()) or (state='claimed' and lease_until<now()) order by created_at for update skip locked limit 10)
 update pair_alert_outbox p set state='claimed',attempts=attempts+1,lease_token=extensions.gen_random_uuid(),lease_until=now()+interval '2 minutes' from due where p.id=due.id returning p.*
$$;
create function public.finish_pair_alert(p_id uuid,p_lease uuid,p_error text default null) returns boolean language plpgsql security definer set search_path=public as $$
begin
 update pair_alert_outbox set state=case when p_error is null then 'sent' when attempts>=6 then 'failed' else 'queued' end,
 sent_at=case when p_error is null then now() else sent_at end,last_error=left(p_error,300),
 next_attempt_at=now()+make_interval(secs=>(least(1800,60*power(2,least(attempts,5))))::integer),lease_token=null,lease_until=null
 where id=p_id and lease_token=p_lease and state='claimed';
 return found;
end $$;
revoke all on function observe_pair_alert(uuid,text,boolean,text),claim_pair_alerts(),finish_pair_alert(uuid,uuid,text) from public,anon,authenticated;
grant execute on function observe_pair_alert(uuid,text,boolean,text),claim_pair_alerts(),finish_pair_alert(uuid,uuid,text) to service_role;

create table public.comparison_history_cache (
 key text primary key, asset text not null, interval text not null, start_ms bigint not null,end_ms bigint not null,
 state text not null default 'pending' check(state in('pending','running','ready','blocked','error')),
 data jsonb, error text, source text, lease_until timestamptz, updated_at timestamptz not null default now()
);
alter table comparison_history_cache enable row level security;
revoke all on comparison_history_cache from public,anon,authenticated,service_role;
grant select on comparison_history_cache to authenticated;
grant all on comparison_history_cache to service_role;
create policy owner_comparison_history on comparison_history_cache to authenticated using(auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy service_comparison_history on comparison_history_cache to service_role using(true) with check(true);
create function public.request_comparison_history(p_asset text,p_interval text,p_start bigint,p_end bigint) returns jsonb language plpgsql security definer set search_path=public as $$
declare k text;r comparison_history_cache%rowtype;
begin
 if (auth.jwt()->>'email') is distinct from 'jasonblick@zohomail.com' or auth.uid() is null then raise exception 'Owner only';end if;
 if p_asset is null or p_interval is null or p_start is null or p_end is null or p_start<=0 or p_end>extract(epoch from now())*1000+60000 or p_asset!~'^[A-Za-z0-9_.:-]{1,100}$' or p_interval not in('1m','5m','15m','30m','1h','4h','1d','1w') or p_start>=p_end or p_end-p_start>400*86400000::bigint then raise exception 'Invalid range';end if;
 k:=md5(p_asset||':'||p_interval||':'||p_start||':'||p_end);
 insert into comparison_history_cache(key,asset,interval,start_ms,end_ms) values(k,p_asset,p_interval,p_start,p_end) on conflict do nothing;
 select * into r from comparison_history_cache where key=k;
 return jsonb_build_object('key',k,'state',r.state,'data',r.data,'error',r.error,'source',r.source);
end $$;
revoke all on function request_comparison_history(text,text,bigint,bigint) from public,anon;
grant execute on function request_comparison_history(text,text,bigint,bigint) to authenticated;
notify pgrst,'reload schema';

-- Claim one bounded history job atomically. A crashed worker can be replaced.
create function public.claim_comparison_history() returns setof comparison_history_cache language sql security definer set search_path=public as $$
 with due as(select key from comparison_history_cache where state='pending' or (state='running' and lease_until<now()) order by updated_at for update skip locked limit 1)
 update comparison_history_cache c set state='running',lease_until=now()+interval '5 minutes',updated_at=now() from due where c.key=due.key returning c.*
$$;
revoke all on function claim_comparison_history() from public,anon,authenticated;
grant execute on function claim_comparison_history() to service_role;
-- Prevent two saved pairs from attributing the same live account position twice.
create function public.validate_pair_config() returns trigger language plpgsql set search_path=public as $$
begin
 if coalesce(new.config->>'source','') not in('manual','account') or new.config->>'assetA' is null or new.config->>'assetB' is null or new.config->>'assetA'=new.config->>'assetB' or jsonb_array_length(new.config->'legs') is distinct from 2 then raise exception 'Invalid pair';end if;
 if new.config->>'source'='account' and not new.archived then
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,0));
  if exists(select 1 from pair_trades p where p.user_id=new.user_id and p.id<>new.id and not p.archived and p.config->>'source'='account' and array[p.config->>'assetA',p.config->>'assetB'] && array[new.config->>'assetA',new.config->>'assetB']) then raise exception 'This account position is already tracked in another saved pair. Archive that pair first.';end if;
 end if;
 return new;
end $$;
create trigger validate_pair_config before insert or update on pair_trades for each row execute function validate_pair_config();
notify pgrst,'reload schema';
