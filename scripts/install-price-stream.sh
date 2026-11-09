#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Credentials are provisioned separately; never pass them as command arguments.
test -r /home/ubuntu/.config/hyperdata/price-stream.env
sudo install -d -o root -g root -m 0755 /opt/hyperdata-price-stream/scripts/price-stream /opt/hyperdata-price-stream/supabase/functions/_shared /opt/hyperdata-price-stream/supabase/functions/deliver-alerts
sudo install -m 0644 scripts/price-stream/*.ts /opt/hyperdata-price-stream/scripts/price-stream/
sudo install -m 0644 supabase/functions/deno.json supabase/functions/deno.lock /opt/hyperdata-price-stream/supabase/functions/
sudo install -m 0644 supabase/functions/_shared/types.ts /opt/hyperdata-price-stream/supabase/functions/_shared/
sudo install -m 0644 supabase/functions/deliver-alerts/{service,dispatcher,email,sms,ntfy,templates}.ts /opt/hyperdata-price-stream/supabase/functions/deliver-alerts/
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/hyperdata-price-stream
sudo -u ubuntu env DENO_DIR=/var/lib/hyperdata-price-stream/deno /usr/local/bin/deno cache \
  --config /opt/hyperdata-price-stream/supabase/functions/deno.json /opt/hyperdata-price-stream/scripts/price-stream/worker.ts
sudo install -m 0644 scripts/systemd/hyperdata-price-stream.service /etc/systemd/system/hyperdata-price-stream.service
sudo systemctl daemon-reload
sudo systemctl enable hyperdata-price-stream.service
sudo systemctl restart hyperdata-price-stream.service
sudo systemctl is-active hyperdata-price-stream.service
