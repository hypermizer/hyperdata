#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY' | sudo -u postgres /usr/lib/postgresql/16/bin/psql -X -h /run/postgresql-hyperdata -p5545 -d hyperdata_core -vON_ERROR_STOP=1
from pathlib import Path
import re
print("create table if not exists public.server_schema_migrations(version text primary key,applied_at timestamptz not null default now());")
print("revoke all on public.server_schema_migrations from public,anon,authenticated,service_role;")
for path in sorted(Path('runtime/core/migrations').glob('*.sql')):
 assert re.fullmatch(r'[0-9a-z_]+\.sql',path.name)
 print("begin;select pg_advisory_xact_lock(71673291);")
 print("select not exists(select 1 from public.server_schema_migrations where version='"+path.name+"') as apply_migration \\gset")
 print('\\if :apply_migration')
 print(path.read_text())
 print("insert into public.server_schema_migrations(version) values('"+path.name+"');")
 print('\\endif\ncommit;')
PY
