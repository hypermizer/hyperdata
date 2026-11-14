# Hyperdata

Personal Hyperliquid utility for a live watchlist and unattended alerts. Hyperdata is hosted only on the Ohio server, with [Tailscale access](https://dev-mini-ohio.tail628a67.ts.net:8446/) and [browser-certificate access](https://3.131.225.164/), both linked from the Webapp gateway. There is no separate Hyperdata sign-in. Price alerts run continuously on the server without GitHub, Supabase, or an open browser. Paper trading, watchlists, analytics, preferences, and account history also run in local PostgreSQL; Supabase is no longer a live dependency. See [server access](docs/server-access.md).

## Alerts

- Fixed price: inclusive above/below mark-price threshold, then automatically disables after the first occurrence.
- Large move: recurring one-minute evaluation of an endpoint log return against a pre-move robust EWMA volatility forecast and an empirical calibration for that asset and horizon.
- Every price alert sends an iPhone notification through the existing Hyprgarden ntfy topic. Email delivery is disabled.
- Independent delivery records, rapid retries, and live-stream health are visible in Alerts.
- Historical notification records are preserved; new alerts use ntfy only.

Detection, occurrences, and notification attempts are persisted separately. Provider failure cannot erase a detected occurrence. An empirical percentile is not a Gaussian probability or a trade recommendation.

## Runtime

Dot references cover every active asset, independent of favourites or open browsers. A dedicated mark store, raw historical mark recovery, 15-second coverage audits, and automatic browser updates keep all seven windows supplied. Prices and reference timestamps are verified; trade candles are not used as mark substitutes. See [all-asset mark operations](docs/local-data.md#canonical-mark-references-for-every-asset).

The supervised server runtime evaluates Hyperliquid mark-price WebSocket updates, syncs qualifying touches to disk, and atomically records occurrences and independent delivery jobs in local PostgreSQL. A separate HTTP monitor checks every 15 seconds. Ntfy sends directly from the server with leases, retries, health checks, and an independent external watchdog.

The root volume is 240 GiB; a separate 50 GiB encrypted volume holds both databases, liquidation data, and backups. Backups run every 15 minutes to Ohio and Tokyo. The API uses a separate HTTPS Elastic IP, mutual TLS, CSRF protection, a restricted database role, and a Unix socket. Provider secrets stay outside the API and source tree.

The CHARTS tab displays live candle charts for watched assets. Shared candle/history sliders, grid columns/rows, chart height, drag order, and individual pan/zoom views persist in local PostgreSQL with a browser cache.

The COMPARE tab overlays two exact-venue assets on one timeline. Percentage mode uses one shared completed candle as the baseline; price mode clearly separates the left and right axes. Only matching trade-candle observations are compared, with visible gaps for missing data. The pair, display mode, candle/history settings, and time viewport persist on the private server with a browser cache. Reconnects resynchronize both histories without changing the active baseline.

The feed normally updates about once per second. Exchange outages and provider/iPhone conditions prevent a hard real-time guarantee. See [price alert operations](docs/price-alerts.md) for semantics, deployment, verification, backups, and recovery.

## Liquidation visualization

Open an asset chart in the private server app and enable **Show liquidation levels**. Current long/short exposure appears at the right edge; an optional 24-hour heatmap shows historical snapshots behind the candles. Range/side filters, nearby zones, snapshot age, and coverage details are included. A separate collector keeps the 0xArchive key on the server and caches data independently of alerts. These are approximately five-minute projected snapshots, with position-state limitations shown in the UI. See [liquidation operations](docs/liquidations.md).

## Paper trading

The Paper tab is a personal, ledger-backed Hyperliquid perpetual simulator. Each account starts with the capital selected when it is created and resets to that same amount. Immediate orders use visible public book depth; resting fills use conservative public-trade queue replay. The server processor handles mark revaluation, hourly funding, and cross/isolated liquidation without requiring an open browser.

Order amounts can be entered as exchange-sized shares or USDC notional; USDC inputs are rounded down to the asset's published size precision. Market orders follow Hyperliquid's SDK convention of an aggressive IOC limit protected at 5% from book mid. The engine applies published tiered margin, 14 completed UTC-day fee volume, HIP-3 deployer/growth fee scaling, funding, reduce-only rules, and partial-liquidation cooldown mechanics.

Fidelity boundaries are explicit: public L2 snapshots cannot expose another trader's exact queue priority, public trade replay occurs on the 10-second processor cadence, and simulated orders never enter Hyperliquid's matching engine or affect its book. Resting fills therefore use a conservative queue estimate and fail closed across trade-data gaps. Staking/referral fee discounts and validator-specific matching-engine behavior are not simulated. Treat results as high-fidelity paper estimates, not exact counterfactual fills.

`PAPER_TRADING_ENABLED` is independent of alert delivery and gates owner trade commands. The migrated production settings preserve `PAPER_TRADING_ENABLED=true` and `PAPER_PROCESSOR_ENABLED=true`. `PAPER_PROCESSOR_ENABLED` separately gates the 10-second server processor, allowing a processor-only shadow while the UI and commands remain read-only. Diagnostic pruning remains scheduled in either state. Activation requires a separate `PAPER_SCHEDULER_SECRET` and a successful shadow run. Raw paper market inputs are retained for 7 days and processor runs for 30 days. Fills, orders, ledger entries, funding, liquidations, and account epochs are never pruned by the diagnostic retention job.

Health is available in `paper_processor_health` and the private `/api/health` response. Disable processing by setting `PAPER_PROCESSOR_ENABLED=false` in root-only `/etc/hyperdata/core.env` and restarting `hyperdata-core@paper`; this preserves all account history.

For the activation shadow, keep `PAPER_TRADING_ENABLED=false`, set `PAPER_PROCESSOR_ENABLED=true`, run `select public.ensure_paper_shadow_account()` with the service role, and collect 24 hours of `paper_processor_health`. Activation requires zero reconciliation failures or duplicate economic effects, acceptable scheduler lag/API weight, and an explicit reviewed change enabling commands and the UI.

## Production setup

Deploy the direct alert runtime with `bash scripts/deploy-alert-runtime.sh` and inspect it with `bash scripts/verify-direct-alert-runtime.sh`. Root-only configuration lives in `/etc/hyperdata/`; production data lives in `/srv/hyperdata`. See the [operations guide](docs/price-alerts.md) for initial provisioning and recovery.

The application backend uses a private Unix-socket PostgREST service and local function handlers. Hosted functions and production Supabase workflows are removed, all hosted schedules are disabled, and the former Data API exposes only an empty retirement schema. The former database remains fenced as a rollback archive because its paid plan does not permit pausing. Public GitHub Pages serves only a retirement notice. See [local data operations](docs/local-data.md) for the migration audit, deployment, backups, and recovery.

## Local development

```bash
npm install
bash scripts/install-postgrest.sh # pinned local data API
npm test
npm run test:edge
npm run test:runtime # requires PostgreSQL binaries; uses a disposable cluster
npm run test:db # requires PostgreSQL 16 + pgTAP; disposable cluster and Unix REST API
npm run check
npm run serve
```

The browser loads locally bundled application code and holds only a private CSRF nonce and owner profile. SMTP, ntfy, local signing/service tokens, and scheduler credentials stay in protected server configuration. The pinned Supabase protocol SDK remains as an open-source client for local PostgREST; it never contacts Supabase.
