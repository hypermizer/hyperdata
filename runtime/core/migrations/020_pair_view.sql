create table public.pair_view_preferences(
 user_id uuid primary key references auth.users(id) on delete cascade,
 settings jsonb not null default '{}'::jsonb check(jsonb_typeof(settings)='object' and octet_length(settings::text)<=16384),
 updated_at timestamptz not null default now()
);
alter table pair_view_preferences enable row level security;
revoke all on pair_view_preferences from public,anon,authenticated,service_role;
grant select,insert,update,delete on pair_view_preferences to authenticated;
create policy owner_pair_view on pair_view_preferences to authenticated using(user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com') with check(user_id=auth.uid() and auth.jwt()->>'email'='jasonblick@zohomail.com');

-- Return each leg's actual observation timestamp, including incomplete buckets.
-- Never turn an old/absent leg quote into an apparently synchronized pair.
create or replace function public.pair_mark_history(p_assets text[],p_start timestamptz,p_end timestamptz,p_interval integer default 60) returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if (auth.jwt()->>'email') is distinct from 'jasonblick@zohomail.com' or auth.uid() is null then raise exception 'Owner only';end if;
 if p_assets is null or cardinality(p_assets)<>2 or p_assets[1] is null or p_assets[2] is null or p_assets[1]=p_assets[2] or p_start is null or p_end is null or p_interval is null or p_interval<15 or p_interval>86400 or p_start>=p_end or p_end>now()+interval '5 seconds' or p_end-p_start>interval '400 days' then raise exception 'Invalid history';end if;
 if ceil(extract(epoch from p_end-p_start)/p_interval)>6000 then raise exception 'Choose a wider sample interval';end if;
 with samples as (
 select distinct on(asset,floor(extract(epoch from observed_at)/p_interval)) asset,floor(extract(epoch from observed_at)/p_interval) as slot,observed_at,price,source
 from (select asset,observed_at,price,source from mark_price_samples where asset=any(p_assets) and observed_at between p_start and p_end union all select asset,observed_at,price,source from pair_mark_samples where asset=any(p_assets) and observed_at between p_start and p_end) observations
 order by asset,floor(extract(epoch from observed_at)/p_interval),observed_at desc
 ), a as(select * from samples where asset=p_assets[1]),b as(select * from samples where asset=p_assets[2]), paired as (
 select coalesce(a.slot,b.slot) as slot,extract(epoch from greatest(a.observed_at,b.observed_at)) as time,
 a.price as "priceA",b.price as "priceB",extract(epoch from a.observed_at) as "observedA",extract(epoch from b.observed_at) as "observedB",a.source as "sourceA",b.source as "sourceB"
 from a full join b using(slot) order by time)
 select jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(paired)),'[]'),'basis','mark','interval',p_interval) into result from paired;
 return result;
end $$;
revoke all on function pair_mark_history(text[],timestamptz,timestamptz,integer) from public,anon;
grant execute on function pair_mark_history(text[],timestamptz,timestamptz,integer) to authenticated;
notify pgrst,'reload schema';
