# Price alert operations

Fixed-price rules fire once when the exact asset's Hyperliquid **mark price** is at or above/below the configured target, inclusively. A target already met when armed fires on the next received mark. Trades, oracle prices, and book mids are not substituted for mark prices. Venue prefixes remain part of asset identity. Prices and targets in notifications retain up to 12 decimal places.

## Continuous detection

`hyperdata-price-stream.service` runs on the existing Ohio server, with outbound connections only. It subscribes to `activeAssetCtx` for armed assets and BTC as a health sentinel, reconnects with bounded backoff, checks feed freshness, and reloads rules through Supabase Realtime with a five-second polling fallback. The exchange currently sends these contexts about once per second; there is no guaranteed latency SLA. `observedAt` records local receipt time because this feed does not include an exchange event timestamp.

The first qualifying tick is written to a mode-0600 local spool and synced to disk before being submitted to Supabase. The spool survives worker restarts and temporary database outages. Supabase locks and rechecks the rule, its revision, observation time, and threshold, then atomically records the occurrence, creates independent email/ntfy outbox rows, disables the one-shot rule, and records its triggered state. A concurrent fallback check cannot duplicate that occurrence. Disabling, deleting, or rearming a rule invalidates candidates from its previous revision.

The existing `monitor-market` function continues checking every 15 seconds, and large-move statistics still use minute buckets. A brief touch entirely inside a feed/server outage cannot be reconstructed from later mark snapshots. The backup limits outage exposure but does not remove this boundary.

## Delivery

Every fixed-price alert sends to `jasonblick@zohomail.com` through Zoho SMTP and to the existing Hyprgarden ntfy topic. The listener claims ntfy deliveries before waking the email Edge Function and sends them in parallel. This uses the server's dedicated outbound address: Supabase's shared egress returned ntfy HTTP 429 during production verification. Generic Edge drains give the dedicated sender a ten-second head start, then remain available as a fallback. No ntfy topic or SMTP credential belongs in browser code or source control.

Outbox claims expire after two minutes; finalization must match the current claim attempt. Provider failures retry after 5, 10, 20, 40, 80, 160, then 300 seconds, up to 12 attempts. Accepted email is never resent because the ntfy channel failed. Email retries use a stable Message-ID. After uncertain network/provider outcomes, a retry can produce a duplicate: neither SMTP nor ntfy offers an exactly-once transaction with our database. `sent` means provider acceptance, not proof of mailbox placement or an iPhone displaying the banner. iOS/Apple, ntfy availability and limits, phone connectivity, and notification settings remain delivery dependencies.

The dashboard displays both delivery states and live-stream health. A once-per-minute watchdog runs independently in Supabase and sends service notices for a stale listener, durable detections stuck over 30 seconds, or deliveries stuck over two minutes. Notices repeat at most every 15 minutes, followed by a recovery notice. It attempts both providers, so an ntfy outage can still be reported by email. A watchdog also depends on the database and at least one working provider.

## Deploy and inspect

Credentials are in `/home/ubuntu/.config/hyperdata/price-stream.env` (0600), including `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MONITOR_SECRET`, `PRICE_WORKER_ID`, `PRICE_SPOOL_PATH`, `DELIVERY_ENABLED=true`, `NTFY_BASE_URL`, and `NTFY_TOPIC`. The ntfy values reuse `/home/ubuntu/.config/hypergarden/ntfy.env`. Matching ntfy secrets are stored in Supabase and GitHub Actions for the fallback. Do not print any credential file.

After changing listener code, run:

```bash
bash scripts/install-price-stream.sh
sudo systemctl status hyperdata-price-stream --no-pager
sudo journalctl -u hyperdata-price-stream --since '10 minutes ago' --no-pager
```

The installer copies source into `/opt/hyperdata-price-stream`, caches pinned dependencies, installs the hardened systemd unit, and enables startup/restart supervision. The spool and cache live in `/var/lib/hyperdata-price-stream`. Browser/terminal origins and authentication are unaffected; the worker opens no inbound port. GitHub's Supabase deployment does not install this host service, so deploy host changes with the installer as well.

Run `scripts/verify-alert-runtime.mjs` with protected management/scheduler credentials to verify stream freshness, fallback cadence, large-move calibration, and any due provider deliveries. It reads `price_stream_health`, `monitor_runs`, `alert_occurrences`, and `notification_outbox`. Deployment verification failures are surfaced without globally switching off retries.

To pause delivery, set `DELIVERY_ENABLED=false` in **both** the protected worker environment (then restart the service) and Supabase Edge secrets/GitHub variable. Detection continues to persist occurrences. Stop the host service to pause continuous detection; the 15-second fallback remains active. Do not delete the spool or outbox to pause notifications.

## Verification

The change includes browser-state tests, stream/equality/transient-touch/restart tests, malformed-price rejection, independent delivery tests, and database tests for revision checks, same-bucket rearming, channel claims, lease fencing, and watchdog throttling/recovery. Database regression checks were also rehearsed against hosted PostgreSQL in rolled-back transactions, without sending messages. Controlled live GOLD and BTC rules verify HIP-3 and native asset detection and actual provider acceptance; temporary rules are soft-deleted while delivery evidence remains available.

References: [Hyperliquid subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions), [heartbeats](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/timeouts-and-heartbeats), [ntfy publishing](https://docs.ntfy.sh/publish/), [ntfy iOS delivery](https://docs.ntfy.sh/config/#ios-instant-notifications).

On 2026-11-09, the fresh BTC verification triggered through the WebSocket path 1.55 seconds after rule creation. Receipt-to-database time was 66 ms; ntfy accepted its first attempt 376 ms after the occurrence and Zoho accepted its first attempt after 2.64 seconds. These are observed test timings, not guaranteed delivery bounds. The earlier GOLD check also confirmed HIP-3 asset identity and that ntfy retries could recover without resending an already accepted email.
