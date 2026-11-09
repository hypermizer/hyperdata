alter table public.market_history_state add column if not exists assets_expected integer not null default 0;
notify pgrst,'reload schema';
