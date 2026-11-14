-- Retain observed prices for saved trades independently of the rolling dot store.
create table public.pair_mark_samples(asset text not null,bucket timestamptz not null,observed_at timestamptz not null,price numeric not null check(price>0),source text not null check(source in('hyperliquid_mark','0xarchive_mark')),primary key(asset,bucket));
create index pair_mark_samples_lookup on pair_mark_samples(asset,observed_at desc) include(price,source);
alter table pair_mark_samples enable row level security;
revoke all on pair_mark_samples from public,anon,authenticated,service_role;
grant all on pair_mark_samples to service_role;
create policy service_pair_samples on pair_mark_samples to service_role using(true) with check(true);
create function public.seed_pair_marks(p_assets text[],p_start timestamptz) returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 if p_assets is null or cardinality(p_assets)<>2 or p_start is null then raise exception 'Invalid pair';end if;
 insert into pair_mark_samples select asset,bucket,observed_at,price,source from mark_price_samples where asset=any(p_assets) and observed_at>=p_start on conflict do nothing;
 get diagnostics n=row_count;return n;
end $$;
revoke all on function seed_pair_marks(text[],timestamptz) from public,anon,authenticated;
grant execute on function seed_pair_marks(text[],timestamptz) to service_role;
create or replace function public.pair_mark_history(p_assets text[],p_start timestamptz,p_end timestamptz,p_interval integer default 60) returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if (auth.jwt()->>'email') is distinct from 'jasonblick@zohomail.com' or auth.uid() is null then raise exception 'Owner only';end if;
 if p_assets is null or cardinality(p_assets)<>2 or p_start is null or p_end is null or p_interval is null or p_interval<60 or p_interval>86400 or p_start>=p_end or p_end-p_start>interval '400 days' then raise exception 'Invalid history';end if;
 with samples as (
 select distinct on(asset,floor(extract(epoch from observed_at)/p_interval)) asset,floor(extract(epoch from observed_at)/p_interval) as slot,observed_at,price,source
 from (select asset,observed_at,price,source from mark_price_samples where asset=any(p_assets) and observed_at between p_start and p_end union all select asset,observed_at,price,source from pair_mark_samples where asset=any(p_assets) and observed_at between p_start and p_end) observations
 order by asset,floor(extract(epoch from observed_at)/p_interval),observed_at desc
 ), paired as (
 select a.slot as slot,extract(epoch from greatest(a.observed_at,b.observed_at)) as time,a.price as "priceA",b.price as "priceB",a.source as "sourceA",b.source as "sourceB"
 from samples a join samples b using(slot) where a.asset=p_assets[1] and b.asset=p_assets[2] order by time limit 6000)
 select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(paired)),'[]'),'basis','mark') into result from paired;
 return result;
end $$;
revoke all on function pair_mark_history(text[],timestamptz,timestamptz,integer) from public,anon;
grant execute on function pair_mark_history(text[],timestamptz,timestamptz,integer) to authenticated;

notify pgrst,'reload schema';
