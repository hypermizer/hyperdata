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
