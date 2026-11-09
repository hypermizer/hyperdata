# Liquidation overlays

Open an asset in **Assets → Overview** on https://3.131.225.164 and select **Show liquidation levels**. The latest snapshot appears as a price profile on the right edge: cyan for projected long liquidations, orange for shorts. Select ±2%, ±5%, or ±10% around the snapshot mark, and filter by side. **24h heatmap** loads retained historical snapshots behind the candles. The profile is not painted backward across historical candles. Existing support/resistance Levels are a separate feature.

Move the chart crosshair over a price zone to inspect its current long/short notional and position counts. The table lists nearby price intervals, USD exposure, position counts, distance from the live mark, and estimated exposure change since the preceding snapshot. Comparison uses overlapping absolute price intervals rather than matching moving bucket indices. Counts remain the provider's counts; they are not inferred by the comparison. Coverage and interpretation details show whole-book totals, approximate/unallocated exposure, source resolution when provided, and timing limitations.

## Data interpretation

These are 0xArchive projections computed from position and margin state. They are not exchange-published liquidation instructions, completed liquidations, or proof that price will reach a zone. Source snapshots update roughly every five minutes. Account-state blocks can be 30–65 minutes older; core positions are advanced using fills, while HIP-3 positions are not. Intervening isolated-margin changes and funding are not applied. HIP-3 cross-margin exposure is excluded from bands and included in `flagged_notional`.

The UI displays snapshot age, identifies delays after 15 minutes, and hides the current profile after two hours. Historical bands cover at most the five minutes following their snapshot, stopping at the next snapshot; gaps stay blank. Buckets are price zones, not precise liquidation prices. A narrower display does not increase source resolution. A shrinking zone is labeled exposure change, not confirmed liquidation. Missing coverage is not zero exposure.

## Server operation

A separate unprivileged `hyperdata-liquidations.service` calls REST on `api.0xarchive.io:443`. Root-only `/etc/hyperdata/oxarchive.env` holds `OXARCHIVE_API_KEY`. `/etc/hyperdata/liquidations.env` selects its dedicated local PostgreSQL role. The key is never passed to the API, browser, public source, or logs. The collector cannot read or update alert rules or deliveries. Price alert workers are independent.

Certificate-authenticated `POST /api/liquidations/watch` records demand only after exact-Origin and CSRF validation. `GET /api/liquidations?asset=...&history=1` reads cached snapshots. The API role cannot change snapshots or provider state. Health-only and revoked client certificates cannot access either route. The public GitHub Pages version links to the private asset page; it never directly proxies the provider or receives the key.

The collector uses venue-specific core/HIP-3 routes, preserving complete symbol identity. It requests a ±10% window with 100 buckets, validates response identity/timestamps/numbers, bounds payloads and timeouts, and stores snapshots by asset and timestamp. Narrower UI ranges filter cached data. A database advisory lock prevents concurrent collectors; history cursors and budgets survive restarts.

Only viewed markets are collected. Browser heartbeats expire after two minutes, shared cached reads do not spend provider credits, and latest reads run no more frequently than every five minutes per market. History is requested only when its checkbox is enabled, uses at most 100 snapshots per page, and refreshes its 24-hour backfill window after six hours if still requested. At most eight markets can be active. Limits are 200 upstream requests per UTC day and 1,000 per UTC month, with a 5,000-credit reserve when the provider reports its balance. Account, quota, and retry conditions are shown in the UI. No plan upgrade or automatic payment is performed. These request caps are operational limits, not a claim that every route has the same credit cost.

Snapshots are retained locally for 30 days, request logs for 35 days, and the UI reads the most recent 24 hours. PostgreSQL backups to Ohio/Tokyo include these tables automatically.

## Deploy and inspect

After securely provisioning the root-only key file:

```bash
bash scripts/install-liquidations.sh
npm test
npm run test:runtime
npm run check
bash scripts/deploy-alert-runtime.sh
sudo systemctl status hyperdata-liquidations --no-pager
sudo journalctl -u hyperdata-liquidations --since '10 minutes ago' --no-pager
```

The installer adds the schema and narrowly scoped database grants without restarting the database. Regular deployment caches pinned dependencies, installs the unit, and restarts it when its protected configuration exists. Stop only `hyperdata-liquidations` to pause collection; cached data and alert monitoring remain available. Never print the key file. For provider recovery, fix the account/key issue first, then clear `liquidation_provider_state.cooldown_until` and set its status to `ready` using the database owner. This resumes existing durable demand and history cursors.

Verification covers response validation, venue identity, historical alignment, recentered-bucket comparisons, stale data, CSRF/certificate restrictions, cache deduplication, concurrency limits, quota pauses, and the history-toggle race. Live browser checks use actual BTC and GOLD snapshots, 24-hour BTC history, interval/asset switching, side filters, and toggle removal. Temporary test certificates are revoked and their keys deleted after deployment.

References: [0xArchive methodology and timing](https://docs.0xarchive.io/rest-api/liquidation-levels), [core levels](https://docs.0xarchive.io/api-reference/hyperliquid--liquidations/get-hyperliquid-liquidation-levels), [HIP-3 levels](https://docs.0xarchive.io/api-reference/hip-3--liquidations/get-hip-3-liquidation-levels), [history](https://docs.0xarchive.io/api-reference/hyperliquid--liquidations/get-hyperliquid-liquidation-levels-history), [rate limits](https://docs.0xarchive.io/rate-limits).
