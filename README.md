# Hyperdata

Personal Hyperliquid utility for a live watchlist and unattended alerts. The private server app is available at https://3.131.225.164/#/alerts with the existing browser client certificate. Price alerts run continuously on the server without GitHub, Supabase, or an open browser. Other cloud features retain their existing backend.

## Alerts

- Fixed price: inclusive above/below mark-price threshold, then automatically disables after the first occurrence.
- Large move: recurring one-minute evaluation of an endpoint log return against a pre-move robust EWMA volatility forecast and an empirical calibration for that asset and horizon.
- Every fixed-price alert sends both Zoho email to `jasonblick@zohomail.com` and an iPhone notification through the existing Hyprgarden ntfy topic.
- Independent delivery records, rapid retries, and live-stream health are visible in Alerts.
- Historical notification records are preserved; new alerts always use email and iPhone notifications.

Detection, occurrences, and notification attempts are persisted separately. Provider failure cannot erase a detected occurrence. An empirical percentile is not a Gaussian probability or a trade recommendation.

## Runtime

The supervised server runtime evaluates Hyperliquid mark-price WebSocket updates, syncs qualifying touches to disk, and atomically records occurrences and independent delivery jobs in local PostgreSQL. A separate HTTP monitor checks every 15 seconds. Email and ntfy send directly from the server with leases, retries, health checks, and an independent external watchdog.

The root volume is 240 GiB; a separate 50 GiB encrypted volume holds alert data. Backups run every 15 minutes to Ohio and Tokyo. The API uses a separate HTTPS Elastic IP, mutual TLS, CSRF protection, a restricted database role, and a Unix socket. Provider secrets stay outside the API and source tree.

The feed normally updates about once per second. Exchange outages and provider/iPhone conditions prevent a hard real-time guarantee. See [price alert operations](docs/price-alerts.md) for semantics, deployment, verification, backups, and recovery.

## Paper trading

The Paper tab is a personal, ledger-backed Hyperliquid perpetual simulator. Each account starts with the capital selected when it is created and resets to that same amount. Immediate orders use visible public book depth; resting fills use conservative public-trade queue replay. The server processor handles mark revaluation, hourly funding, and cross/isolated liquidation without requiring an open browser.

Order amounts can be entered as exchange-sized shares or USDC notional; USDC inputs are rounded down to the asset's published size precision. Market orders follow Hyperliquid's SDK convention of an aggressive IOC limit protected at 5% from book mid. The engine applies published tiered margin, 14 completed UTC-day fee volume, HIP-3 deployer/growth fee scaling, funding, reduce-only rules, and partial-liquidation cooldown mechanics.

Fidelity boundaries are explicit: public L2 snapshots cannot expose another trader's exact queue priority, public trade replay occurs on the 10-second processor cadence, and simulated orders never enter Hyperliquid's matching engine or affect its book. Resting fills therefore use a conservative queue estimate and fail closed across trade-data gaps. Staking/referral fee discounts and validator-specific matching-engine behavior are not simulated. Treat results as high-fidelity paper estimates, not exact counterfactual fills.

`PAPER_TRADING_ENABLED` is independent of alert delivery and defaults to `false`; it gates authenticated trade commands. `PAPER_PROCESSOR_ENABLED` separately gates the 10-second server processor, allowing a processor-only shadow while the UI and commands remain read-only. Diagnostic pruning remains scheduled in either state. Activation requires a separate `PAPER_SCHEDULER_SECRET` and a successful shadow run. Raw paper market inputs are retained for 7 days and processor runs for 30 days. Fills, orders, ledger entries, funding, liquidations, and account epochs are never pruned by the diagnostic retention job.

Health is available in `paper_processor_health`. Disable processing by setting `PAPER_PROCESSOR_ENABLED=false` and rerunning `scripts/configure-supabase-runtime.mjs`; this preserves all account history.

For the activation shadow, keep `PAPER_TRADING_ENABLED=false`, set `PAPER_PROCESSOR_ENABLED=true`, run `select public.ensure_paper_shadow_account()` with the service role, and collect 24 hours of `paper_processor_health`. Activation requires zero reconciliation failures or duplicate economic effects, acceptable scheduler lag/API weight, and an explicit reviewed change enabling commands and the UI.

## Production setup

Deploy the direct alert runtime with `bash scripts/deploy-alert-runtime.sh` and inspect it with `bash scripts/verify-direct-alert-runtime.sh`. Root-only configuration lives in `/etc/hyperdata/`; production data lives in `/srv/hyperdata`. See the [operations guide](docs/price-alerts.md) for initial provisioning and recovery.

The existing GitHub/Supabase deployment still serves other application features. The legacy alert scheduler and delivery flags are disabled, and a database cutover guard prevents accidental reactivation. GitHub Pages links to the private alert app; it is not an intermediary for alerts.

## Local development

```bash
npm install
supabase start
npm test
npm run test:edge
npm run test:runtime # requires PostgreSQL binaries; uses a disposable cluster
npm run test:db
npm run check
npm run serve
```

The browser contains only the Supabase publishable key for the remaining cloud features. SMTP, ntfy, service-role, and scheduler credentials must remain in protected server configuration or the existing cloud secret stores.
