-- Keep API access stable across Supabase/Postgres image changes. RLS policies
-- decide which rows are visible; these grants decide which operations can reach
-- those policies in the first place.
revoke all on table
  public.watchlist_items,
  public.alert_rules,
  public.market_observations,
  public.detector_models,
  public.calibration_jobs,
  public.monitor_runs,
  public.rule_evaluation_state,
  public.alert_occurrences,
  public.notification_outbox,
  public.volatility_states
from anon, authenticated;

grant select, insert, update, delete
on table public.watchlist_items
to authenticated;

grant select, insert, update
on table public.alert_rules
to authenticated;

grant select
on table
  public.monitor_runs,
  public.rule_evaluation_state,
  public.alert_occurrences,
  public.notification_outbox
to authenticated;

grant all privileges
on table
  public.watchlist_items,
  public.alert_rules,
  public.market_observations,
  public.detector_models,
  public.calibration_jobs,
  public.monitor_runs,
  public.rule_evaluation_state,
  public.alert_occurrences,
  public.notification_outbox,
  public.volatility_states
to service_role;
