-- Manual retries recover failed/provider-blocked lookups without an automatic
-- paid API retry loop. Valid immutable cached observations remain unchanged.
drop function public.request_comparison_history(text,text,bigint,bigint);
create function public.request_comparison_history(p_asset text,p_interval text,p_start bigint,p_end bigint,p_retry boolean default false) returns jsonb language plpgsql security definer set search_path=public as $$
declare k text;r comparison_history_cache%rowtype;
begin
 if (auth.jwt()->>'email') is distinct from 'jasonblick@zohomail.com' or auth.uid() is null then raise exception 'Owner only';end if;
 if p_asset is null or p_interval is null or p_start is null or p_end is null or p_start<=0 or p_end>extract(epoch from now())*1000+60000 or p_asset!~'^[A-Za-z0-9_.:-]{1,100}$' or p_interval not in('1m','5m','15m','30m','1h','4h','1d','1w') or p_start>=p_end or p_end-p_start>400*86400000::bigint then raise exception 'Invalid range';end if;
 k:=md5(p_asset||':'||p_interval||':'||p_start||':'||p_end);
 insert into comparison_history_cache(key,asset,interval,start_ms,end_ms) values(k,p_asset,p_interval,p_start,p_end) on conflict(key) do update set state='pending',error=null,lease_until=null,updated_at=now()
 where p_retry and comparison_history_cache.state in('blocked','error') and comparison_history_cache.updated_at<now()-interval '30 seconds';
 select * into r from comparison_history_cache where key=k;
 return jsonb_build_object('key',k,'state',r.state,'data',r.data,'error',r.error,'source',r.source);
end $$;
revoke all on function request_comparison_history(text,text,bigint,bigint,boolean) from public,anon;
grant execute on function request_comparison_history(text,text,bigint,bigint,boolean) to authenticated;

create index pair_alert_due on pair_alert_outbox(state,next_attempt_at,lease_until) where state in('queued','claimed');
create index pair_alert_recent on pair_alert_outbox(pair_id,metric,created_at desc);
notify pgrst,'reload schema';
