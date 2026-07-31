-- Synthetic rollout accounts were useful during initial development, but they
-- must never compete with real accounts in the latency-critical paper engine.
update public.strategy_assignments assignment
set state = 'paused', updated_at = now()
from public.paper_accounts account
where assignment.account_id = account.id
  and account.name = '__SHADOW__ ORCL'
  and assignment.state <> 'paused';

update public.paper_accounts
set archived_at = coalesce(archived_at, now())
where name = '__SHADOW__ ORCL';
