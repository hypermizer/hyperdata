# Hyperdata

Personal Hyperliquid utility for a live watchlist and unattended alerts. It is a static GitHub Pages app backed by Supabase; no browser needs to remain open for alert evaluation.

## Alerts

- Fixed price: inclusive above/below mark-price threshold, then automatically disables after the first occurrence.
- Large move: recurring one-minute evaluation of an endpoint log return against a pre-move robust EWMA volatility forecast and an empirical calibration for that asset and horizon.
- Email: Zoho SMTP over TLS 465.
- Text: Twilio SMS when the sender is permitted to message the destination.

Detection, occurrences, and notification attempts are persisted separately. Provider failure cannot erase a detected occurrence. An empirical percentile is not a Gaussian probability or a trade recommendation.

## Runtime

Three Supabase Edge Functions are scheduled through `pg_cron`:

- `monitor-market` every minute: batches Hyperliquid market context by DEX, stores observations, evaluates rules, and records health.
- `rebuild-calibrations` every 15 minutes: drains bounded calibration jobs and refreshes versioned models.
- `deliver-alerts` every minute: drains the durable outbox with leases, retries, and explicit terminal or ambiguous states.

Market observations are retained for 30 days and monitor runs for 14 days. One-minute scheduling on the Supabase Free tier is not trading-grade and can be delayed; health is visible in the Alerts tab.

## Paper trading

The Paper tab is a personal, ledger-backed Hyperliquid perpetual simulator. Each account starts with the capital selected when it is created and resets to that same amount. Immediate orders use visible public book depth; resting fills use conservative public-trade queue replay. The server processor handles mark revaluation, hourly funding, and cross/isolated liquidation without requiring an open browser.

`PAPER_TRADING_ENABLED` is independent of alert delivery and defaults to `false`; it gates authenticated trade commands. `PAPER_PROCESSOR_ENABLED` separately gates the 10-second server processor, allowing a processor-only shadow while the UI and commands remain read-only. Diagnostic pruning remains scheduled in either state. Activation requires a separate `PAPER_SCHEDULER_SECRET` and a successful shadow run. Raw paper market inputs are retained for 7 days and processor runs for 30 days. Fills, orders, ledger entries, funding, liquidations, and account epochs are never pruned by the diagnostic retention job.

Health is available in `paper_processor_health`. Disable processing by setting `PAPER_PROCESSOR_ENABLED=false` and rerunning `scripts/configure-supabase-runtime.mjs`; this preserves all account history.

For the activation shadow, keep `PAPER_TRADING_ENABLED=false`, set `PAPER_PROCESSOR_ENABLED=true`, run `select public.ensure_paper_shadow_account()` with the service role, and collect 24 hours of `paper_processor_health`. Activation requires zero reconciliation failures or duplicate economic effects, acceptable scheduler lag/API weight, and an explicit reviewed change enabling commands and the UI.

## Production setup

The deployment workflow requires these GitHub Actions secrets:

- `SUPABASE_ACCESS_TOKEN`
- `MONITOR_SECRET` (a long random value)
- Existing delivery secrets: `ALERT_EMAIL`, `ALERT_SMS_TO`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`

The workflow applies migrations, deploys functions, copies provider settings into Edge secrets, writes the scheduler values to Vault, and configures cron. The equivalent manual scheduler recovery is:

```sql
select vault.create_secret('https://itheknkmuutquriojdzt.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>', 'service_role_key');
select vault.create_secret('<same MONITOR_SECRET>', 'monitor_secret');
select public.configure_listener_cron();
```

Keep `DELIVERY_ENABLED=false` for the initial shadow period. After at least 24 hours of fresh one-minute monitor runs, calibration checks, and a controlled provider smoke test, set it to `true`. Only then retire the legacy GitHub Action monitor.

## Local development

```bash
npm install
supabase start
npm test
npm run test:edge
npm run test:db
npm run check
npm run serve
```

The browser contains only the Supabase publishable key. Service-role, scheduler, SMTP, Twilio, email, and phone values must remain in Supabase/GitHub secrets.
