#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mountpoint -q /srv/hyperdata
release="$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%S)"
release_path="/opt/hyperdata-runtime/releases/$release"
sudo install -d -m 0755 "$release_path" /opt/hyperdata-runtime/cache
sudo rsync -a --exclude=tests --exclude=__pycache__ runtime public "$release_path/"
sudo install -d "$release_path/supabase/functions"
sudo cp supabase/functions/deno.{json,lock} "$release_path/supabase/functions/"
sudo rsync -a --exclude=tests supabase/functions/ "$release_path/supabase/functions/"
# Preserve the import paths used by the stream engine and shared detector modules.
sudo install -d "$release_path/scripts/price-stream"
sudo cp scripts/price-stream/*.ts "$release_path/scripts/price-stream/"
sudo install -d "$release_path/scripts/lib"
sudo cp scripts/refresh-asset-analytics.mjs "$release_path/scripts/"
sudo cp scripts/lib/{asset-analytics-refresh,local-data}.js "$release_path/scripts/lib/"
sudo env DENO_DIR=/opt/hyperdata-runtime/cache /usr/local/bin/deno cache --frozen --config "$release_path/supabase/functions/deno.json" "$release_path/runtime/api.ts" "$release_path/runtime/monitor.ts" "$release_path/runtime/watchdog.ts" "$release_path/runtime/liquidation-collector.ts" "$release_path/runtime/owner-backend.ts" "$release_path/runtime/core-worker.ts" "$release_path/runtime/core-maintenance.ts"
sudo chown -R root:root "$release_path" /opt/hyperdata-runtime/cache
sudo chmod -R a+rX "$release_path" /opt/hyperdata-runtime/cache
sudo ln -sfn "$release_path" /opt/hyperdata-runtime/current.next
sudo mv -Tf /opt/hyperdata-runtime/current.next /opt/hyperdata-runtime/current
sudo install -m 0644 scripts/systemd/hyperdata-{api,stream,monitor,watchdog,backup}.service /etc/systemd/system/
sudo install -m 0644 scripts/systemd/hyperdata-{watchdog,backup}.timer /etc/systemd/system/
sudo install -m 0755 scripts/backup-alert-runtime.sh /usr/local/sbin/backup-hyperdata
if sudo test -s /etc/hyperdata/core.env; then
 sudo install -m 0644 scripts/systemd/hyperdata-data.service scripts/systemd/hyperdata-core@.service scripts/systemd/hyperdata-core-maintenance.{service,timer} scripts/systemd/hyperdata-analytics.{service,timer} /etc/systemd/system/
fi
sudo systemctl daemon-reload
if sudo test -s /etc/hyperdata/owner-backend.env; then
 sudo install -m 0644 scripts/systemd/hyperdata-owner.service /etc/systemd/system/
 sudo systemctl daemon-reload
 sudo systemctl enable hyperdata-owner
 sudo systemctl restart hyperdata-owner
fi
sudo systemctl enable hyperdata-api hyperdata-stream hyperdata-monitor hyperdata-watchdog.timer hyperdata-backup.timer
sudo systemctl restart hyperdata-api hyperdata-stream hyperdata-monitor
sudo systemctl start hyperdata-watchdog.timer hyperdata-backup.timer
sudo systemctl is-active hyperdata-api hyperdata-stream hyperdata-monitor
if sudo test -s /etc/hyperdata/liquidations.env; then
 sudo install -m 0644 scripts/systemd/hyperdata-liquidations.service /etc/systemd/system/
 sudo systemctl daemon-reload
 sudo systemctl enable hyperdata-liquidations
 sudo systemctl restart hyperdata-liquidations
 sudo systemctl is-active hyperdata-liquidations
fi
if sudo test -s /etc/hyperdata/tailnet.env; then
 sudo install -m 0644 scripts/systemd/hyperdata-tailnet.service /etc/systemd/system/
 sudo systemctl daemon-reload
 sudo systemctl enable hyperdata-tailnet hyperdata-tailnet-identity.timer
 sudo systemctl restart hyperdata-tailnet
 sudo systemctl start hyperdata-tailnet-identity.timer
fi
if sudo test -s /etc/hyperdata/core.env; then
 sudo systemctl enable hyperdata-data hyperdata-core@paper hyperdata-core@account-sync hyperdata-core-maintenance.timer hyperdata-analytics.timer
 sudo systemctl restart hyperdata-core@paper hyperdata-core@account-sync
 sudo systemctl start hyperdata-core-maintenance.timer hyperdata-analytics.timer
fi
printf 'Deployed Hyperdata runtime release %s\n' "$release"
