#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mountpoint -q /srv/hyperdata || { echo 'Dedicated data volume must be mounted first.' >&2; exit 1; }
sudo test -s /etc/hyperdata/api.env
sudo test -s /etc/hyperdata/worker.env
sudo test -s /etc/hyperdata/providers.env
if ! id hyperdata >/dev/null 2>&1; then sudo useradd --system --home-dir /srv/hyperdata/state --no-create-home --shell /usr/sbin/nologin hyperdata; fi
if ! id hyperdata-api >/dev/null 2>&1; then sudo useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin hyperdata-api; fi
sudo groupadd -f hyperdata-db
sudo usermod -a -G hyperdata-db postgres
sudo usermod -a -G hyperdata-db hyperdata
sudo usermod -a -G hyperdata-db hyperdata-api
sudo install -d -o postgres -g hyperdata-db -m 0770 /run/postgresql-hyperdata
sudo install -d -o hyperdata -g hyperdata -m 0700 /srv/hyperdata/spool /srv/hyperdata/state
sudo install -d -o root -g root -m 0700 /srv/hyperdata/backups
if ! pg_lsclusters --no-header | awk '$1=="16" && $2=="hyperdata"{found=1}END{exit !found}'; then
 sudo pg_createcluster 16 hyperdata --port 5545 --datadir /srv/hyperdata/postgresql --socketdir /run/postgresql-hyperdata --start-conf auto -- --auth-local=peer --auth-host=scram-sha-256
fi
sudo pg_conftool 16 hyperdata set listen_addresses ''
sudo pg_conftool 16 hyperdata set unix_socket_directories /run/postgresql-hyperdata
sudo pg_conftool 16 hyperdata set unix_socket_group hyperdata-db
sudo pg_conftool 16 hyperdata set unix_socket_permissions 0770
sudo pg_conftool 16 hyperdata set shared_buffers 128MB
sudo pg_conftool 16 hyperdata set max_connections 40
sudo tee /etc/postgresql/16/hyperdata/pg_hba.conf >/dev/null <<'PGHBA'
local all postgres peer
local hyperdata hyperdata peer
local hyperdata hyperdata-api peer
local all all reject
PGHBA
sudo install -d /etc/systemd/system/postgresql@16-hyperdata.service.d
sudo tee /etc/systemd/system/postgresql@16-hyperdata.service.d/storage.conf >/dev/null <<'UNIT'
[Unit]
RequiresMountsFor=/srv/hyperdata
[Service]
ExecStartPre=+/usr/bin/install -d -o postgres -g hyperdata-db -m 0770 /run/postgresql-hyperdata
UNIT
sudo tee /etc/tmpfiles.d/hyperdata-postgresql.conf >/dev/null <<'TMP'
d /run/postgresql-hyperdata 0770 postgres hyperdata-db -
TMP
sudo systemctl daemon-reload
sudo systemctl restart postgresql@16-hyperdata
sudo -u postgres psql -h /run/postgresql-hyperdata -p 5545 -v ON_ERROR_STOP=1 -d postgres <<'SQL'
select 'create role hyperdata login' where not exists(select 1 from pg_roles where rolname='hyperdata')\gexec
select 'create role "hyperdata-api" login' where not exists(select 1 from pg_roles where rolname='hyperdata-api')\gexec
select 'create database hyperdata owner hyperdata' where not exists(select 1 from pg_database where datname='hyperdata')\gexec
SQL
sudo -u hyperdata psql -h /run/postgresql-hyperdata -p 5545 -d hyperdata -v ON_ERROR_STOP=1 < runtime/migrations/001_alerts.sql
sudo -u postgres psql -h /run/postgresql-hyperdata -p 5545 -d hyperdata -v ON_ERROR_STOP=1 <<'SQL'
revoke all on database hyperdata from public;
grant connect on database hyperdata to hyperdata,"hyperdata-api";
revoke create on schema public from public;
grant usage on schema public to "hyperdata-api";
grant select on alert_rules,alert_occurrences,notification_outbox,rule_evaluation_state,runtime_health,runtime_settings,revoked_clients to "hyperdata-api";
grant insert,update on alert_rules to "hyperdata-api";
grant delete on rule_evaluation_state to "hyperdata-api";
grant insert on audit_events to "hyperdata-api";
grant usage on all sequences in schema public to "hyperdata-api";
SQL
bash scripts/deploy-alert-runtime.sh
