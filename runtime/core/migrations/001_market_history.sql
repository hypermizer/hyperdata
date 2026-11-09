create table if not exists public.market_history_state (
 singleton boolean primary key default true check(singleton),
 heartbeat_at timestamptz, last_frame_at timestamptz, last_persisted_at timestamptz,
 assets_sampled integer not null default 0, connected boolean not null default false,
 last_error text
);
insert into public.market_history_state(singleton) values(true) on conflict do nothing;
alter table public.market_history_state enable row level security;
grant select on public.market_history_state to authenticated;
drop policy if exists "Owner reads market history health" on public.market_history_state;
create policy "Owner reads market history health" on public.market_history_state for select to authenticated using(auth.jwt()->>'email'='jasonblick@zohomail.com');
grant all on public.market_history_state to service_role;
create table if not exists public.market_history_backfills (
 asset text primary key, from_ms bigint not null, completed_at timestamptz,
 retry_after timestamptz not null default now(), last_error text
);
grant all on public.market_history_backfills to service_role;
alter table public.market_history_backfills enable row level security;
create or replace function public.queue_asset_history_repairs() returns integer language plpgsql security definer set search_path=public as $$
declare total integer;
begin
 insert into market_history_backfills(asset,from_ms)
 select asset,greatest(extract(epoch from now()-interval '7 days')::bigint*1000,
 coalesce((price_history->-1->>'time')::bigint-360000,0))
 from asset_analytics_cache where coalesce((price_history->-1->>'time')::bigint,0)<extract(epoch from now()-interval '2 minutes')::bigint*1000
 on conflict(asset) do update set from_ms=least(market_history_backfills.from_ms,excluded.from_ms),completed_at=null,retry_after=now()
 where market_history_backfills.completed_at is not null;
 get diagnostics total=row_count;
 return total;
end $$;
create or replace view public.market_history_repair_queue as
 select b.*,exists(select 1 from watchlist_items w where w.asset=b.asset) as watched
 from market_history_backfills b where completed_at is null;
grant select on public.market_history_repair_queue to service_role;

-- The live sampler and candle repair lock/merge the same row atomically. A
-- historical backfill must never replace samples collected while it was running.
create or replace function public.merge_asset_price_history(p_asset text,p_points jsonb,p_observed_at timestamptz)
returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
 if p_asset !~ '^[a-zA-Z0-9_.:-]+$' or jsonb_typeof(p_points)<>'array' or jsonb_array_length(p_points)>10000 or p_observed_at>now()+interval '1 minute' then
 raise exception 'Invalid history repair' using errcode='22023';end if;
 insert into asset_analytics_cache as cache(asset,price_history,history_updated_at)
 values(p_asset,'[]',p_observed_at) on conflict(asset) do nothing;
 update asset_analytics_cache cache set price_history=(
 select coalesce(jsonb_agg(jsonb_build_object('time',time_ms,'price',price) order by time_ms),'[]') from (
 select distinct on(case when time_ms<extract(epoch from now()-interval '25 hours')::bigint*1000 then floor(time_ms::numeric/3600000) else time_ms end) time_ms,price
 from (
 select (x->>'time')::bigint as time_ms,(x->>'price')::numeric as price,1 as priority from jsonb_array_elements(cache.price_history)x
 union all
 select (x->>'time')::bigint,(x->>'price')::numeric,0 from jsonb_array_elements(p_points)x
 ) points where time_ms between extract(epoch from now()-interval '31 days')::bigint*1000 and extract(epoch from now())::bigint*1000 and price>0
 order by case when time_ms<extract(epoch from now()-interval '25 hours')::bigint*1000 then floor(time_ms::numeric/3600000) else time_ms end,time_ms desc,priority desc
 ) retained),history_updated_at=greatest(cache.history_updated_at,p_observed_at)
 where cache.asset=p_asset;
 get diagnostics affected=row_count;
 update market_history_backfills set completed_at=now(),last_error=null where asset=p_asset;
 return affected;
end $$;

-- Full histories on first load or after a repair, small deltas for regular live
-- sampling. The server watermark also catches historical writes behind a cursor.
create or replace function public.asset_history_updates(p_since timestamptz default null,p_assets text[] default null)
returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object('asOf',statement_timestamp(),'rows',coalesce(jsonb_agg(jsonb_build_object(
 'asset',cache.asset,'price_history',case when p_since is null or coalesce(b.completed_at,'-infinity')>=p_since then cache.price_history else
 (select coalesce(jsonb_agg(x order by (x->>'time')::bigint),'[]') from jsonb_array_elements(cache.price_history)x where (x->>'time')::bigint>=extract(epoch from p_since-interval '2 minutes')::bigint*1000) end
 )),'[]'))
 from asset_analytics_cache cache left join market_history_backfills b on b.asset=cache.asset
 where (p_assets is null or cache.asset=any(p_assets)) and (p_since is null or cache.history_updated_at>=p_since or b.completed_at>=p_since);
$$;
grant select on public.market_history_backfills to authenticated;
drop policy if exists "Owner reads repair progress" on public.market_history_backfills;
create policy "Owner reads repair progress" on public.market_history_backfills for select to authenticated using(auth.jwt()->>'email'='jasonblick@zohomail.com');
revoke all on function public.queue_asset_history_repairs(),public.merge_asset_price_history(text,jsonb,timestamptz),public.asset_history_updates(timestamptz,text[]) from public,anon,authenticated;
grant execute on function public.queue_asset_history_repairs(),public.merge_asset_price_history(text,jsonb,timestamptz) to service_role;
grant execute on function public.asset_history_updates(timestamptz,text[]) to authenticated,service_role;

notify pgrst, 'reload schema';
