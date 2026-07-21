alter table public.strategy_assignments
  add column last_net_return numeric(38, 12);

comment on column public.strategy_assignments.last_net_return is
  'Latest executable strategy net PnL divided by entry initial margin; null when no live projection exists.';
