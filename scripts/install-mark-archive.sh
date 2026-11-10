#!/usr/bin/env bash
set -euo pipefail
sudo test -s /etc/hyperdata/oxarchive.env
if ! id hyperdata-archive >/dev/null 2>&1; then sudo useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin hyperdata-archive;fi
sudo usermod -a -G hyperdata-data hyperdata-archive
sudo python3 - <<'PY'
from pathlib import Path
import shlex,json,time,base64,hmac,hashlib
root=Path('/etc/hyperdata')
v=dict(x.split('=',1) for x in shlex.split((root/'core.env').read_text()) if '=' in x)
def b64(b):return base64.urlsafe_b64encode(b).decode().rstrip('=')
payload=b64(b'{"alg":"HS256","typ":"JWT"}')+'.'+b64(json.dumps({'role':'history_archive','iss':'hyperdata-local','iat':int(time.time())}).encode())
token=payload+'.'+b64(hmac.new(v['LOCAL_JWT_SECRET'].encode(),payload.encode(),hashlib.sha256).digest())
p=root/'archive-marks.env';p.write_text('LOCAL_DATA_URL=http://local-data\nLOCAL_DATA_SOCKET=/run/hyperdata-data/rest.sock\nLOCAL_SERVICE_TOKEN='+token+'\n');p.chmod(0o600)
PY
