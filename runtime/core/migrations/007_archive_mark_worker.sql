do $$begin if not exists(select 1 from pg_roles where rolname='history_archive') then create role history_archive nologin;end if;end $$;
grant history_archive to "hyperdata-rest";
grant usage on schema public to history_archive;
grant select on mark_history_assets,mark_reference_coverage,mark_archive_jobs,mark_archive_usage to history_archive;
create policy archive_mark_assets on mark_history_assets for select to history_archive using(true);
create policy archive_mark_coverage on mark_reference_coverage for select to history_archive using(true);
alter table mark_archive_jobs add column lease_token uuid;
alter table mark_archive_jobs add column lease_until timestamptz;
create function public.claim_mark_archive_job() returns jsonb language plpgsql security definer set search_path=public as $$
declare job mark_archive_jobs%rowtype;
begin
 select j.* into job from mark_archive_jobs j join mark_history_assets a using(asset) where a.active and j.retry_at<=now() and (j.state='pending' or j.state='running' and j.lease_until<now()) order by j.updated_at,j.asset,j.band desc for update of j skip locked limit 1;
 if not found then return null;end if;
 update mark_archive_jobs set state='running',lease_token=extensions.gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now() where asset=job.asset and band=job.band returning * into job;
 return to_jsonb(job);
end $$;
create function public.reserve_mark_archive_request() returns boolean language plpgsql security definer set search_path=public as $$
declare recent bigint;credits bigint;
begin
 perform pg_advisory_xact_lock(71564291);
 select sum(requests),min(credits_remaining) into recent,credits from mark_archive_usage where day>=date_trunc('month',current_date)::date;
 if coalesce(recent,0)>=40000 or coalesce(credits,100000)<5000 or (select requests>=10000 from mark_archive_usage where day=current_date) then return false;end if;
 insert into mark_archive_usage(day,requests) values(current_date,1) on conflict(day)do update set requests=mark_archive_usage.requests+1;
 return true;
end $$;
create function public.finish_mark_archive_page(p_asset text,p_band integer,p_lease uuid,p_points jsonb,p_cursor text,p_error text,p_retry_seconds integer,p_credits bigint) returns boolean language plpgsql security definer set search_path=public as $$
begin
 perform 1 from mark_archive_jobs where asset=p_asset and band=p_band and lease_token=p_lease and state='running' for update;
 if not found then return false;end if;
 if p_error is null then perform merge_mark_observations(p_asset,p_points,'0xarchive_mark');end if;
 update mark_archive_jobs set cursor=case when p_error is null then p_cursor else cursor end,state=case when p_error is null and p_cursor is null then 'complete' else 'pending' end,updated_at=now(),retry_at=now()+make_interval(secs=>greatest(0,least(p_retry_seconds,86400))),last_error=p_error,lease_token=null,lease_until=null where asset=p_asset and band=p_band and lease_token=p_lease;
 update mark_archive_usage set credits_remaining=coalesce(p_credits,credits_remaining),last_error=p_error where day=current_date;
 return true;
end $$;
revoke all on function public.claim_mark_archive_job(),public.reserve_mark_archive_request(),public.finish_mark_archive_page(text,integer,uuid,jsonb,text,text,integer,bigint) from public,anon,authenticated;
grant execute on function public.claim_mark_archive_job(),public.reserve_mark_archive_request(),public.finish_mark_archive_page(text,integer,uuid,jsonb,text,text,integer,bigint) to history_archive,service_role;
revoke all on function public.merge_mark_observations(text,jsonb,text) from history_archive;
notify pgrst,'reload schema';
