-- Dots use genuine mark observations exclusively. Trade candles remain available
-- for candle-based analytics, but are never substituted for a missing mark.
create table public.mark_history_assets(asset text primary key,dex text not null,active boolean not null default true,catalog_at timestamptz not null default now());
create table public.mark_price_samples(asset text not null,bucket timestamptz not null,observed_at timestamptz not null,price numeric not null check(price>0),source text not null check(source in ('hyperliquid_mark','0xarchive_mark')),primary key(asset,bucket));
create index mark_price_samples_lookup on public.mark_price_samples(asset,observed_at desc) include(price,source);
create table public.mark_reference_coverage(asset text not null,horizon integer not null,checked_at timestamptz not null,reference_at timestamptz,price numeric,source text,primary key(asset,horizon));
create table public.mark_archive_jobs(asset text not null,band integer not null,start_ms bigint not null,end_ms bigint not null,cursor text,state text not null default 'pending',updated_at timestamptz not null default now(),retry_at timestamptz not null default now(),last_error text,primary key(asset,band));
create table public.mark_archive_usage(day date primary key,requests integer not null default 0,credits_remaining bigint,last_error text);
revoke all on public.mark_history_assets,public.mark_price_samples,public.mark_reference_coverage,public.mark_archive_jobs,public.mark_archive_usage from public,anon,authenticated;
grant all on public.mark_history_assets,public.mark_price_samples,public.mark_reference_coverage,public.mark_archive_jobs,public.mark_archive_usage to service_role;
grant select on public.mark_history_assets,public.mark_price_samples,public.mark_reference_coverage to authenticated;
alter table public.mark_history_assets enable row level security;
alter table public.mark_price_samples enable row level security;
alter table public.mark_reference_coverage enable row level security;
create policy owner_mark_assets on public.mark_history_assets for select to authenticated using(auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy owner_mark_samples on public.mark_price_samples for select to authenticated using(auth.jwt()->>'email'='jasonblick@zohomail.com');
create policy owner_mark_references on public.mark_reference_coverage for select to authenticated using(auth.jwt()->>'email'='jasonblick@zohomail.com');

create function public.sync_mark_history_assets(p_assets jsonb) returns void language plpgsql security definer set search_path=public as $$
begin
 if jsonb_array_length(p_assets)<1 or jsonb_array_length(p_assets)>1000 then raise exception 'Invalid market universe';end if;
 update mark_history_assets set active=false;
 insert into mark_history_assets(asset,dex) select x->>'asset',x->>'dex' from jsonb_array_elements(p_assets)x
 on conflict(asset) do update set dex=excluded.dex,active=true,catalog_at=now();
end $$;
create function public.merge_mark_observations(p_asset text,p_points jsonb,p_source text) returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
 if p_source not in ('hyperliquid_mark','0xarchive_mark') or jsonb_array_length(p_points)>1000 or not exists(select 1 from mark_history_assets where asset=p_asset and active) then raise exception 'Invalid mark observations';end if;
 insert into mark_price_samples as samples(asset,bucket,observed_at,price,source)
 select p_asset,date_trunc('minute',stamp),stamp,price,p_source from (
  select distinct on(date_trunc('minute',to_timestamp((x->>'time')::numeric/1000))) to_timestamp((x->>'time')::numeric/1000) as stamp,(x->>'price')::numeric as price
  from jsonb_array_elements(p_points)x where (x->>'price')::numeric>0 and (x->>'time')::numeric between extract(epoch from now()-interval '8 days')*1000 and extract(epoch from now())*1000
  order by date_trunc('minute',to_timestamp((x->>'time')::numeric/1000)),(x->>'time')::numeric desc
 ) points on conflict(asset,bucket) do update set observed_at=excluded.observed_at,price=excluded.price,source=excluded.source where excluded.observed_at>samples.observed_at;
 get diagnostics affected=row_count;return affected;
end $$;
create function public.record_live_mark_batch(p_observed_at timestamptz,p_samples jsonb) returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
 if p_observed_at>now()+interval '5 seconds' or p_observed_at<now()-interval '2 minutes' or jsonb_array_length(p_samples)>1000 then raise exception 'Invalid live marks';end if;
 insert into mark_price_samples as samples(asset,bucket,observed_at,price,source)
 select x->>'asset',date_trunc('minute',p_observed_at),p_observed_at,(x->>'price')::numeric,'hyperliquid_mark' from jsonb_array_elements(p_samples)x join mark_history_assets a on a.asset=x->>'asset' and a.active where (x->>'price')::numeric>0
 on conflict(asset,bucket) do update set observed_at=excluded.observed_at,price=excluded.price,source=excluded.source where excluded.observed_at>samples.observed_at;
 get diagnostics affected=row_count;return affected;
end $$;

create function public.refresh_mark_reference_coverage() returns jsonb language plpgsql security definer set search_path=public as $$
declare total integer;ready integer;
begin
 insert into mark_reference_coverage(asset,horizon,checked_at,reference_at,price,source)
 select a.asset,h.minutes,statement_timestamp(),s.observed_at,s.price,s.source
 from mark_history_assets a cross join (values(10080),(1440),(360),(60),(30),(10),(5))h(minutes)
 left join lateral(select observed_at,price,source from mark_price_samples p where p.asset=a.asset and p.observed_at<=statement_timestamp()-make_interval(mins=>h.minutes) and p.observed_at>=statement_timestamp()-make_interval(mins=>h.minutes)-interval '2 minutes' order by p.observed_at desc limit 1)s on true where a.active
 on conflict(asset,horizon) do update set checked_at=excluded.checked_at,reference_at=excluded.reference_at,price=excluded.price,source=excluded.source;
 -- Repair every missing asset/window, with no favourite/watchlist ordering.
 insert into mark_archive_jobs(asset,band,start_ms,end_ms)
 select asset,band,extract(epoch from statement_timestamp()-make_interval(mins=>start_minutes)-interval '2 minutes')::bigint*1000,
 extract(epoch from least(statement_timestamp(),statement_timestamp()-make_interval(mins=>start_minutes)+interval '6 hours'))::bigint*1000 from (
 select distinct c.asset,case when c.horizon<=60 then 60 else c.horizon end as band,case when c.horizon<=60 then 65 else c.horizon end as start_minutes
 from mark_reference_coverage c join mark_history_assets a using(asset) where a.active and c.reference_at is null
 ) gaps on conflict(asset,band) do update set start_ms=excluded.start_ms,end_ms=excluded.end_ms,cursor=null,state='pending',retry_at=now(),last_error=null
 where mark_archive_jobs.state='complete' and mark_archive_jobs.updated_at<now()-interval '10 minutes';
 select count(*),count(reference_at) into total,ready from mark_reference_coverage c join mark_history_assets a using(asset) where a.active;
 return jsonb_build_object('total',total,'ready',ready,'missing',total-ready);
end $$;
create function public.asset_mark_reference_snapshot() returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object('asOf',statement_timestamp(),'rows',coalesce(jsonb_agg(jsonb_build_object('asset',asset,'mark_history',points)),'[]')) from (
 select a.asset,coalesce(jsonb_agg(jsonb_build_object('time',extract(epoch from c.reference_at)*1000,'price',c.price,'source',c.source,'horizon',c.horizon) order by c.reference_at) filter(where c.reference_at is not null),'[]')points
 from mark_history_assets a left join mark_reference_coverage c using(asset) where a.active group by a.asset
 ) rows;
$$;
create function public.mark_reference_health() returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object('assets',(select count(*) from mark_history_assets where active),'total',count(*),'ready',count(reference_at),'missing',count(*)-count(reference_at),'oldestCheck',min(checked_at)) from mark_reference_coverage c join mark_history_assets a using(asset) where a.active;
$$;
create function public.prune_mark_samples() returns bigint language plpgsql security definer set search_path=public as $$
declare affected bigint;begin delete from mark_price_samples where observed_at<now()-interval '8 days';get diagnostics affected=row_count;return affected;end $$;
revoke all on function public.sync_mark_history_assets(jsonb),public.merge_mark_observations(text,jsonb,text),public.record_live_mark_batch(timestamptz,jsonb),public.refresh_mark_reference_coverage(),public.asset_mark_reference_snapshot(),public.mark_reference_health(),public.prune_mark_samples() from public,anon,authenticated;
grant execute on function public.sync_mark_history_assets(jsonb),public.merge_mark_observations(text,jsonb,text),public.record_live_mark_batch(timestamptz,jsonb),public.refresh_mark_reference_coverage(),public.asset_mark_reference_snapshot(),public.mark_reference_health(),public.prune_mark_samples() to service_role;
grant execute on function public.asset_mark_reference_snapshot(),public.mark_reference_health() to authenticated;
notify pgrst,'reload schema';
