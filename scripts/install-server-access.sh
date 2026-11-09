#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! sudo test -x /opt/hyperdata-gateway-venv/bin/python; then
 sudo python3 -m venv /opt/hyperdata-gateway-venv
fi
sudo /opt/hyperdata-gateway-venv/bin/pip install -r deploy/gateway-requirements.txt
if ! id hyperdata-gateway >/dev/null 2>&1; then
 sudo useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin hyperdata-gateway
fi
sudo install -m 0755 scripts/renew-tailnet-identity.py /usr/local/libexec/hyperdata-renew-tailnet-identity.py
sudo python3 - <<'PY'
from pathlib import Path
import shlex,json
source=Path('/etc/webapp/us-phone-terminal-bridge.env').read_text()
env=dict(entry.split('=',1) for entry in shlex.split(source,comments=True) if '=' in entry)
owner=env['TAILNET_OWNER_LOGIN']
path=Path('/etc/hyperdata/tailnet.env')
path.write_text('TAILNET_OWNER_LOGIN='+json.dumps(owner)+'\n')
path.chmod(0o600)
path=Path('/etc/hyperdata/api.env')
text='\n'.join(line for line in path.read_text().splitlines() if not line.startswith('ADDITIONAL_ORIGINS='))
path.write_text(text+'\nADDITIONAL_ORIGINS=https://dev-mini-ohio.tail628a67.ts.net:8446\n')
path.chmod(0o600)
path=Path('/etc/hyperdata/worker.env')
text='\n'.join(line for line in path.read_text().splitlines() if not line.startswith('NOTIFICATION_ORIGIN='))
path.write_text(text+'\nNOTIFICATION_ORIGIN=https://dev-mini-ohio.tail628a67.ts.net:8446\n')
path.chmod(0o600)
PY
sudo install -m 0644 scripts/systemd/hyperdata-tailnet.service scripts/systemd/hyperdata-tailnet-identity.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start hyperdata-tailnet-identity.service
printf 'Dedicated Tailscale entrance prepared. Deploy the runtime before enabling its service and Serve route.\n'
