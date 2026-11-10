-- One-time genuine mark recovery must cover the whole market universe, while preserving provider credits and prohibiting purchases.
create or replace function public.reserve_mark_archive_request() returns boolean language plpgsql security definer set search_path=public as $$
declare recent bigint;credits bigint;
begin
 perform pg_advisory_xact_lock(71564291);
 select sum(requests),min(credits_remaining) into recent,credits from mark_archive_usage where day>=date_trunc('month',current_date)::date;
 if coalesce(recent,0)>=90000 or coalesce(credits,100000)<5000 or (select requests>=15000 from mark_archive_usage where day=current_date) then return false;end if;
 insert into mark_archive_usage(day,requests) values(current_date,1) on conflict(day)do update set requests=mark_archive_usage.requests+1;
 return true;
end $$;

notify pgrst,'reload schema';
