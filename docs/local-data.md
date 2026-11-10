# Local app data operations

Hyperdata has no live Supabase dependency. Both databases run in PostgreSQL 16 on the encrypted `/srv/hyperdata` volume. PostgreSQL and PostgREST listen only on Unix sockets; existing HTTPS Elastic IP origins, client certificates, Tailscale owner/session checks, CSRF, and terminal-session revocation remain in place.

| Component | Location / unit |
| --- | --- |
| Live alerts and liquidation cache | database `hyperdata` |
| Watchlists, analytics, preferences, paper trading, account history | database `hyperdata_core` |
| Database socket | `/run/postgresql-hyperdata/.s.PGSQL.5545` |
| Local REST protocol | PostgREST 16.5, `hyperdata-data`, `/run/hyperdata-data/rest.sock` |
| Owner API and local command/news/fundamentals handlers | `hyperdata-owner`, `/run/hyperdata-owner/backend.sock` |
| Paper processor, original SQL leases and idempotency | `hyperdata-core@paper`, 10-second cadence |
| Hyperliquid history/positions synchronization, original cursors/upsert keys | `hyperdata-core@account-sync`, 60-second cadence |
| Diagnostic retention | `hyperdata-core-maintenance.timer`, daily |
| Continuous watchlist marks / reference repair | `hyperdata-market-history`, minute persistence and incremental gap recovery |
| Historical analytics | `hyperdata-analytics.timer`, hourly; rotating 24 shards |
| Both databases, identities/configuration, globals | `hyperdata-backup.timer`, every 15 minutes, Ohio + Tokyo SSE-KMS copies |

The service URL `http://local-data` is a protocol placeholder. A bounded HTTP adapter sends its requests over the local socket, never through DNS or TCP. The pinned Supabase SDK is retained only as an open-source PostgREST protocol client. There is no GoTrue/auth service, external owner JWT, service-role cloud credential, hosted SQL HTTP, or cloud scheduler in the live path.

Only the owner service and core worker OS users can access PostgREST. Its database login uses peer authentication and cannot inherit the owner/service roles without the PostgREST request selecting a verified local JWT role. Owner JWTs expire after one hour; the browser receives only its owner profile and CSRF nonce. The backend regenerates signed credentials internally, preserving fixed owner ID/email and RLS. No credentials are in source, app config, or public files. Core processing preserves the existing paper/strategy flags; automated strategy execution remains disabled.

Analytics reserves conservative Hyperliquid request weight before every request/retry, targeting no more than 200 weight/minute for background work, and spreads assets over 24 hourly shards. This leaves capacity for live data and account synchronization. The shared exchange/IP limits still apply to other applications and browser traffic. Incomplete refreshes report failure and retain previously cached rows; they do not replace them with invented values.

## Migration audit: 2026-11-09

The source project was `itheknkmuutquriojdzt` (PostgreSQL 17.6). Initial sizes were 2.51 GB database-wide, about 0.47 GB of application relations including indexes, with most remaining space in old cron logs. Storage contained zero buckets and objects.

A full compressed source archive and a final frozen application dump are root-only under `/srv/hyperdata/migration/` and copied with separate regional KMS keys to the existing Ohio and Tokyo backup buckets. The source archive includes historical scheduler/auth metadata; those provider services and old cron logs are not installed locally. The minimal local identity table preserves the existing owner's ID for foreign keys and policies.

For the final copy, the private owner backend was briefly stopped, all four hosted schedules disabled, in-flight processor work drained, and all 51 public tables fenced against API mutations. Exactly **1,237,759 rows in 51 tables** were copied. Sorted per-row MD5 content fingerprints and exact counts matched across every table, including full-precision floating-point serialization. The source Management API defaulted to `extra_float_digits=0`; the independent full-precision comparison explicitly used `3`. Native dumps retained full numeric precision throughout.

Verification covered the original 300 financial/data pgTAP assertions, local permission checks, real Unix REST/RLS/JWT tests, an actual shadow BTC order and exact idempotent replay, local news/fundamentals, both background processors, a complete native backup restore, certificate/Tailscale browser flows, and zero browser Supabase/CDN requests. Disposable shadow accounts remained in disposable databases only. Live account IDs, epochs, histories, and ledger entries were preserved.

The temporary read-only source export role was dropped. Hosted functions and both production Supabase/analytics workflows were removed. The source Data API now exposes only the empty `hyperdata_retired` schema. Supabase rejected pausing because the project is paid; the retained project is a fenced rollback archive and can still incur its existing plan charges. Changing the organization plan or deleting this archive requires a separate owner decision. Never reactivate its schedules or remove mutation guards while the local system is authoritative.

## Deploy and inspect

On a provisioned alert server, run `bash scripts/install-core-runtime.sh` to install the pinned/checksummed PostgREST binary, local OS/SQL roles, peer/socket access, local signing identity, and canonical schema if the database is new. Reinstalling preserves data, keys, and feature flags. Then run:

```bash
npm test
npm run check
npm run test:edge
npm run test:runtime
npm run test:db
bash scripts/deploy-alert-runtime.sh
sudo systemctl status hyperdata-data hyperdata-owner hyperdata-core@paper hyperdata-core@account-sync --no-pager
sudo journalctl -u hyperdata-core@paper -u hyperdata-core@account-sync --since '10 minutes ago' --no-pager
sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d hyperdata_core \
  -c 'select * from paper_processor_health;'
```

Configuration is root-only in `/etc/hyperdata/core.env` and `data.env`; nonsecret PostgREST socket/database settings live in `/etc/hyperdata-data.conf`. `/api/health` combines alert health, recent paper completion/reconciliation, and active account-sync freshness without exposing account data. Local and external watchdogs notify on failures. Services restart automatically and recover from durable SQL cursors/leases; independent live alert units remain separate.

The canonical schema snapshot is `runtime/core/schema.sql`, followed by `localize.sql`, plus the minimal local identity definitions in `bootstrap.sql`. Historical migrations under `supabase/migrations` are retained for audit, not deployment to a provider. New local schema changes must be explicit SQL migrations against `hyperdata_core`; do not rerun the baseline over an existing database.

## Backup and recovery

`/usr/local/sbin/backup-hyperdata` creates `alerts-*.dump`, `core-*.dump`, their SHA-256 sidecars, `config-*.tar.gz`, and `globals-*.sql`, then uploads all artifacts to both existing regional KMS-encrypted buckets. A run fails if the configured core database is missing or either regional copy fails. Local core dumps are retained three days; other local artifacts are retained seven days. Each PostgreSQL dump is internally consistent; alerts and app data are independent databases, so their dump timestamps need not be identical. Configuration archives contain secrets and must remain root-only.

Restore into a **new disposable database first**, using the matching PostgreSQL 16 client. Keep its default `public` schema. Restore required globals/roles on a new cluster before restoring data; restore protected configuration only to root-owned paths. For a source native core backup on this server:

```bash
sudo -u postgres createdb -h /run/postgresql-hyperdata -p5545 hyperdata_restore_verify
sudo cat /srv/hyperdata/backups/core-TIMESTAMP.dump | \
  sudo -u postgres /usr/lib/postgresql/16/bin/pg_restore --exit-on-error --no-owner \
    -h /run/postgresql-hyperdata -p5545 -d hyperdata_restore_verify
sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d hyperdata_restore_verify \
  -c 'select count(*) from paper_ledger_entries;'
```

Check financial balances, epochs, order/fill/ledger counts, ownership policies, and cursors before considering a live replacement. Never restore a stale dump over the live database or run two paper processors against independent writable copies of owner data. A controlled live restore must stop owner/core writers first and resume only after reconciliation. Alert units need not be stopped for a core-only restore. Do not point the app back at the former hosted database as a code rollback.

## Continuous watchlist history

`hyperdata-market-history` subscribes to the exchange's combined mark-context stream, persists real mark observations every minute for every active perpetual, and repairs downtime gaps with incremental exchange candle history. Repairs prioritize watched assets and reserve no more than 600 REST weight/minute (including metadata/retries); a 429 response pauses repairs before retrying. Hourly analytics remains separate and merges its candles atomically rather than replacing newer streamed observations. Historical recovery uses actual trade candle closes; subsequent continuously recorded references use mark observations. Missing history before an asset existed is never synthesized.

The browser loads histories in bounded batches, then polls server-watermarked deltas every minute. Completed repairs resend older reference points behind the cursor, and phone resume never requires one unbounded response. Failed requests retry after 15 seconds; live WebSocket quotes continue independently. The new history checks report stream/persistence freshness and pending reference repairs in `/api/health`, so live-quote health alone no longer hides a stalled history collector.

The 2026-11-09 follow-up corrected the migration's insufficient daily history refresh and its browser's one-time history load. Verification covered all 98 dot windows on the owner's 14 watched assets, live quote frames, and history updates without a page reload, plus transaction tests for concurrent backfill/sample merging, cursor replay, permission enforcement, and recovery after another outage. Newly listed assets can legitimately lack 1-day or 1-week history; these references remain unavailable until real data exists.

Local forward migrations run once through `scripts/apply-core-migrations.sh`, serialized by a PostgreSQL advisory lock and recorded in `server_schema_migrations`. Deploy/install run this automatically before switching code. Never edit an applied migration; add a subsequent migration. The disposable database suite also applies these forward migrations.

## Canonical mark references for every asset

The all-asset follow-up replaces candle-based dot references with a separate, auditable mark store. `mark_history_assets` tracks the complete live exchange universe. `mark_price_samples` stores decimal-safe prices, exact observation timestamps, and either `hyperliquid_mark` or `0xarchive_mark` as provenance. Native observations are recorded every minute; rows are retained eight days. Each dot shows its actual reference timestamp. Trade candles, oracle prices, mids, and values from other venues are not substituted. Dot intensity uses volatility computed from the same genuine mark store.

Every 15 seconds the server evaluates all seven horizons for every active market. Current production verification covered **349 assets and 2,443 pairs**, with every percentage independently checked in the browser across the All and Crypto categories. Health requires the exact expected pair count, no missing references, and a recent audit. A connected quote socket alone cannot make reference coverage healthy.

A second, isolated `hyperdata-archive-marks` service repairs historical marks through 0xArchive's raw price routes, without timestamp-bucketing requests. It prefetches the next reference interval before the current interval expires. Repairs apply to every asset equally and preserve opaque pagination, fixed query boundaries, lease fencing, provider timestamps, and decimal prices. The worker's SQL role can claim/complete mark recovery jobs and cannot read financial accounts or execute paper effects. The API key stays in protected server configuration. No upgrade or payment is automated.

The worker caps concurrency at two and request rate at eight per second, leaving capacity for the existing liquidation collector. Recovery also enforces 15,000 requests/day, 90,000/month and a 5,000-provider-credit reserve, and honors provider failures/retries. The available key capacity was checked before warm-up. These operational ceilings are not a promise that absent upstream data or an exchange outage can be made exact; unavailable data produces an explicit unhealthy/recovery state instead of a fabricated price.

Run `bash scripts/install-mark-archive.sh` after core migrations if installing the recovery worker separately. The core installer invokes it automatically when the protected 0xArchive configuration already exists. Both database/configuration backups continue to go to Ohio and Tokyo; core dumps retain three days locally to bound the growing market-history footprint, while the other local artifacts retain seven days. Remote retention is unchanged.

Earlier assumptions that missing trade candles proved an asset was newly listed were incorrect: the mark archive contained the needed historical observations. Observation-based first-seen metadata was corrected where the archive proved older history. Asset age is never inferred as a reason to skip a missing mark-reference recovery.
