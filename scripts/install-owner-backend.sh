#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
sudo groupadd -f hyperdata-owner-api
if ! id hyperdata-owner >/dev/null 2>&1; then
 sudo useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin hyperdata-owner
fi
sudo usermod -a -G hyperdata-owner-api hyperdata-api
sudo test -s /etc/hyperdata/core.env
sudo python3 - <<'PY'
from pathlib import Path
import shlex,json
p=Path('/etc/hyperdata/api.env')
api=dict(item.split('=',1) for item in shlex.split(p.read_text(),comments=True) if '=' in item)
values=dict(OWNER_ID=api['OWNER_ID'],OWNER_EMAIL='jasonblick@zohomail.com',PUBLIC_ORIGIN=api['PUBLIC_ORIGIN'])
path=Path('/etc/hyperdata/owner-backend.env')
path.write_text(''.join(key+'='+json.dumps(value)+'\n' for key,value in values.items()));path.chmod(0o600)
print('Local owner identity installed. No cloud credentials are required.')
PY
