#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mountpoint -q /srv/hyperdata
sudo test -s /etc/hyperdata/oxarchive.env
if ! id hyperdata-liquidity >/dev/null 2>&1; then
 sudo useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin hyperdata-liquidity
fi
sudo usermod -a -G hyperdata-db hyperdata-liquidity
sudo -u postgres psql -h /run/postgresql-hyperdata -p 5545 -v ON_ERROR_STOP=1 -d postgres <<'SQL'
select 'create role "hyperdata-liquidity" login' where not exists(select 1 from pg_roles where rolname='hyperdata-liquidity')\gexec
SQL
sudo -u hyperdata psql -h /run/postgresql-hyperdata -p 5545 -d hyperdata -v ON_ERROR_STOP=1 < runtime/migrations/002_liquidations.sql
sudo python3 - <<'PY'
from pathlib import Path
p=Path('/etc/postgresql/16/hyperdata/pg_hba.conf')
line='local hyperdata hyperdata-liquidity peer\n'
text=p.read_text()
if line not in text:p.write_text(text.replace('local all all reject',line+'local all all reject'))
p=Path('/etc/hyperdata/liquidations.env')
p.write_text('PGHOST=/run/postgresql-hyperdata\nPGPORT=5545\nPGUSER=hyperdata-liquidity\nPGDATABASE=hyperdata\n')
p.chmod(0o600)
PY
sudo -u postgres psql -h /run/postgresql-hyperdata -p 5545 -d hyperdata -v ON_ERROR_STOP=1 <<'SQL'
grant connect on database hyperdata to "hyperdata-liquidity";
grant usage on schema public to "hyperdata-liquidity";
grant select on liquidation_requests,liquidation_snapshots,liquidation_provider_state to "hyperdata-api";
grant insert,update on liquidation_requests to "hyperdata-api";
grant select,update on liquidation_requests,liquidation_provider_state to "hyperdata-liquidity";
grant select,insert,update,delete on liquidation_snapshots,liquidation_fetch_log to "hyperdata-liquidity";
grant usage on sequence liquidation_fetch_log_id_seq to "hyperdata-liquidity";
select pg_reload_conf();
SQL
printf 'Liquidation schema and isolated database roles installed. Deploy with scripts/deploy-alert-runtime.sh.\n'
