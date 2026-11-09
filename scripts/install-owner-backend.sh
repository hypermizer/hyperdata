#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
sudo groupadd -f hyperdata-owner-api
if ! id hyperdata-owner >/dev/null 2>&1; then
 sudo useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin hyperdata-owner
fi
sudo usermod -a -G hyperdata-owner-api hyperdata-api
sudo python3 - <<'PY'
from pathlib import Path
import shlex,json
def env(path):return dict(item.split('=',1) for item in shlex.split(Path(path).read_text(),comments=True) if '=' in item)
legacy=env('/home/ubuntu/.config/hyperdata/price-stream.env')
api=env('/etc/hyperdata/api.env')
values={key:legacy[key] for key in ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY']}
values.update(OWNER_ID=api['OWNER_ID'],OWNER_EMAIL='jasonblick@zohomail.com',PUBLIC_ORIGIN=api['PUBLIC_ORIGIN'])
path=Path('/etc/hyperdata/owner-backend.env')
path.write_text(''.join(key+'='+json.dumps(value)+'\n' for key,value in values.items()))
path.chmod(0o600)
path=Path('/etc/hyperdata/api.env')
text='\n'.join(line for line in path.read_text().splitlines() if not line.startswith('OWNER_EMAIL='))
path.write_text(text+'\nOWNER_EMAIL=jasonblick@zohomail.com\n')
path.chmod(0o600)
print('Owner identity and upstream credentials installed outside the browser and API process.')
PY
