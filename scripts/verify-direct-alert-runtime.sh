#!/usr/bin/env bash
set -euo pipefail
mountpoint -q /srv/hyperdata
sudo systemctl is-active postgresql@16-hyperdata hyperdata-api hyperdata-stream hyperdata-monitor
sudo -u hyperdata env DENO_DIR=/opt/hyperdata-runtime/cache /usr/local/bin/deno run \
  --cached-only --frozen --config /opt/hyperdata-runtime/current/supabase/functions/deno.json \
  --allow-env --allow-net=unix:/run/postgresql-hyperdata/.s.PGSQL.5545 \
  --allow-read=/opt/hyperdata-runtime,/run/postgresql-hyperdata --allow-write=/run/postgresql-hyperdata \
  /opt/hyperdata-runtime/current/runtime/admin.ts status
curl --silent --show-error --output /dev/null --write-out 'Unauthenticated HTTPS status: %{http_code}\n' https://3.131.225.164/
sudo systemctl list-timers hyperdata-backup.timer hyperdata-watchdog.timer --no-pager
