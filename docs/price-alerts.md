# Price alert operations

The production alert app runs at **https://3.131.225.164/#/alerts** on the Ohio server. Use the existing browser client certificate. Price alert creation, storage, detection, retries, and delivery run directly on this server; GitHub Actions and Supabase are outside this path. The remaining app services, including cloud watchlists and paper trading, still use their existing backend.

## Detection and delivery

Fixed-price rules fire once when the exact asset's Hyperliquid **mark price** is at or above/below the target, inclusively. A target already met when armed fires on the next received mark. Trade, oracle, and book-mid prices are not substituted. Venue prefixes remain part of asset identity. Notification prices retain up to 12 decimal places. The asset picker includes the full available market catalog.

`hyperdata-stream.service` subscribes directly to Hyperliquid `activeAssetCtx` for armed assets and BTC as a health sentinel. PostgreSQL notifications update subscriptions immediately, with a one-second polling fallback. The worker reconnects with bounded backoff and detects stale assets. The feed normally updates about once per second and has no guaranteed latency SLA. `observedAt` is local receipt time because this feed has no exchange event timestamp.

The first qualifying tick is synced to a protected local spool before database submission. PostgreSQL locks and rechecks the rule, revision, asset, observation time, and threshold. One transaction records the occurrence, creates independent email/ntfy outbox rows, and disables the fixed-price rule. Concurrent checks cannot duplicate the occurrence. Disabling, deleting, or rearming invalidates candidates from the prior revision. The spool survives worker restarts and temporary database outages.

`hyperdata-monitor.service` independently checks HTTP mark snapshots every 15 seconds. Recurring large-move rules retain minute-bucket evaluation using endpoint log returns, robust EWMA volatility, and per-asset/horizon empirical calibration. Empirical percentiles are not Gaussian probabilities. A brief threshold touch entirely inside a feed/server outage cannot be recovered from later snapshots.

Each new alert sends **both** Zoho email to `jasonblick@zohomail.com` and a notification to the existing Hyprgarden ntfy topic. The two channels drain independently in parallel, normally immediately after detection, with a one-second queue poll. Claims expire after two minutes, and updates must match the current lease token and attempt. Failures retry after 5, 10, 20, 40, 80, 160, then 300 seconds, up to 288 attempts (about 24 hours). An accepted channel is not resent because the other failed. Email uses a stable Message-ID; delayed notifications explicitly identify the historical trigger price.

`sent` means provider acceptance, not confirmed mailbox placement or an iPhone banner. SMTP and ntfy cannot participate in an exactly-once database transaction, so uncertain provider outcomes can cause duplicate delivery. Network, exchange, provider, phone connectivity, and iOS notification settings prevent a hard real-time guarantee.

## Isolation and storage

The runtime has a dedicated Elastic IP and HTTPS origin. nginx requires the existing client CA, rejects other Host values, and forwards verified certificate identity over a Unix socket. Mutations require the exact origin and a secure SameSite CSRF cookie/token. Certificate revocation is checked for every API request. The primary desktop and terminal origins, certificate checks, and session revocation remain separate.

The unprivileged API has no internet sockets or provider credentials. Its PostgreSQL role can manage rules and read status, but cannot modify delivery records. Separate supervised workers have scoped network access and root-protected provider settings. Zoho's Node SMTP library resolves remote addresses before connection, so its Deno sandbox permits IPv4 port 465 plus the local DNS resolver; HTTPS destinations remain restricted. Dependencies are pinned, cached, and read-only at runtime.

The root EBS volume is 240 GiB, expanded online from 140 GiB. PostgreSQL, spool, and backups use a separate 50 GiB encrypted gp3 volume mounted at `/srv/hyperdata` with `nodev,nosuid,noexec`. PostgreSQL listens only on `/run/postgresql-hyperdata/.s.PGSQL.5545`; it has no TCP listener. Services require the data mount. Credentials are root-only in `/etc/hyperdata/{api,worker,providers}.env`; never print or commit these files. The API configuration contains no SMTP, ntfy, or Supabase secrets.

The IP certificate is short-lived and automatically renewed by certbot. Its deploy hook validates and reloads nginx. Keep `snap.certbot.renew.timer` running.

## Deploy and inspect

Initial host setup is in `scripts/install-alert-runtime.sh`; infrastructure/origin provisioning and controlled migration scripts are in `scripts/`. Provisioning needs the existing target-account administrator session; ordinary deployment does not require AWS administrator credentials.

After changing source, run:

```bash
npm test
npm run test:edge
npm run test:runtime
npm run check
bash scripts/deploy-alert-runtime.sh
bash scripts/verify-direct-alert-runtime.sh
```

The runtime tests start a disposable local PostgreSQL cluster and exercise transactions and delivery fencing. The deployer installs an immutable root-owned release under `/opt/hyperdata-runtime/releases`, atomically switches `current`, and restarts the three supervised services. It never replaces database or spool data. It also installs watchdog and backup timers. Roll back code by switching `current` to a reviewed prior release and restarting the services; do not roll back the database or reactivate the former alert engine.

Inspect status without printing environment files:

```bash
sudo systemctl status hyperdata-api hyperdata-stream hyperdata-monitor --no-pager
sudo journalctl -u hyperdata-stream -u hyperdata-monitor --since '10 minutes ago' --no-pager
sudo -u hyperdata psql -h /run/postgresql-hyperdata -p 5545 -d hyperdata \
  -c "select worker_id,heartbeat_at,details from runtime_health;"
```

For `runtime/admin.ts`, use the restricted invocation in `scripts/verify-direct-alert-runtime.sh`, replacing `status` with `pause`, `activate`, or `revoke-client FINGERPRINT`. Pause stops rule mutations, detection commits, and new delivery claims; in-flight provider requests can finish. Never delete the spool or outbox to pause alerts. To pause only delivery, set the local `runtime_settings.delivery_enabled` JSON value to `false`; detection continues. Restore it to `true` to resume pending deliveries.

The former `hyperdata-price-stream.service` is disabled. Supabase migration `202611090004_local_alert_cutover.sql` records the private origin, blocks old rule writes and occurrence creation, and prevents legacy alert cron from reactivating. Hosted and GitHub alert delivery flags are false. Existing historical records were imported with their sent states preserved. Do not re-enable the old engine: two independent databases would undermine deduplication. GitHub Pages displays a link to the private server and is optional for alert operation.

## Monitoring, backups, and recovery

The local minute watchdog checks stream/fallback heartbeats, stuck delivery records, and database availability. It attempts both email and ntfy, throttles issue notices to 15 minutes, and sends recovery notices. The independent controller checks the public HTTPS origin every minute using a health-only client certificate. It warns through ntfy after two failed checks, repeats at most every 15 minutes, and reports recovery. Its certificate can read `/api/health` but cannot read or change alerts. Neither watchdog eliminates a complete exchange/provider outage.

`hyperdata-backup.timer` runs every 15 minutes. `/usr/local/sbin/backup-hyperdata` writes a PostgreSQL custom-format dump, verifies its archive directory, calculates SHA-256, then uploads encrypted copies to the existing Ohio and Tokyo S3 backup buckets. Local dumps stay for seven days. The existing instance snapshot policy also covers attached EBS volumes. Inspect backup service failures and the timer; a successful local dump alone does not confirm remote upload.

For recovery, stop all Hyperdata services first. Restore the latest verified dump into an isolated PostgreSQL database/host with delivery disabled. Set `runtime_settings.active=false` before exposing the restored API. Restore protected provider configuration and any surviving spool separately. Check counts, rules, sent/unsent outbox states, and spool revisions; old sent rows must remain sent. Validate TLS, client revocation, data mount, and backups, then activate exactly one runtime. A database restore to an earlier point can replay previously accepted messages; reconcile outbox history before activation.

On 2026-11-09 a full dump was restored to a disposable database and its rule, occurrence, and notification counts matched. An Ohio download matched the local SHA-256, and the Tokyo object confirmed KMS encryption. A fresh production browser-created `xyz:GOLD` alert triggered through WebSocket 181 ms after creation; ntfy accepted its first attempt 143 ms after detection and Zoho accepted its first attempt after 1.207 seconds. These are observed timings, not guarantees. Verification rules were soft-deleted while their delivery evidence was retained.

References: [Hyperliquid subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions), [heartbeats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats), [ntfy publishing](https://docs.ntfy.sh/publish/), [ntfy iOS delivery](https://docs.ntfy.sh/config/#ios-instant-notifications).
