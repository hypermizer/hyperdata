#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mountpoint -q /srv/hyperdata
sudo test -s /etc/hyperdata/api.env
bash scripts/install-postgrest.sh
sudo groupadd -f hyperdata-data
sudo groupadd -f hyperdata-owner-api
if ! id hyperdata-owner >/dev/null 2>&1; then sudo useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin hyperdata-owner; fi
for account in hyperdata-rest hyperdata-core; do
 if ! id "$account" >/dev/null 2>&1; then sudo useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$account"; fi
 sudo usermod -a -G hyperdata-data "$account"
done
sudo usermod -a -G hyperdata-db hyperdata-rest
sudo usermod -a -G hyperdata-data hyperdata-owner
sudo usermod -a -G hyperdata-owner-api hyperdata
sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d postgres -vON_ERROR_STOP=1 <<'SQL'
select 'create role anon nologin' where not exists(select 1 from pg_roles where rolname='anon')\gexec
select 'create role authenticated nologin' where not exists(select 1 from pg_roles where rolname='authenticated')\gexec
select 'create role service_role nologin bypassrls' where not exists(select 1 from pg_roles where rolname='service_role')\gexec
select 'create role "hyperdata-rest" login noinherit' where not exists(select 1 from pg_roles where rolname='hyperdata-rest')\gexec
grant authenticated,service_role to "hyperdata-rest";
select 'create database hyperdata_core' where not exists(select 1 from pg_database where datname='hyperdata_core')\gexec
revoke all on database hyperdata_core from public;
grant connect on database hyperdata_core to "hyperdata-rest";
SQL
sudo python3 - <<'PY'
from pathlib import Path
p=Path('/etc/postgresql/16/hyperdata/pg_hba.conf');s=p.read_text();rule='local hyperdata_core hyperdata-rest peer'
if rule not in s:s=s.replace('local all all reject',rule+'\nlocal all all reject');p.write_text(s)
PY
sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d postgres -c 'select pg_reload_conf()' >/dev/null
if [[ "$(sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d hyperdata_core -Atc "select count(*) from pg_namespace where nspname='auth'")" == 0 ]]; then
 sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d hyperdata_core -vON_ERROR_STOP=1 < runtime/core/bootstrap.sql
 sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d hyperdata_core -vON_ERROR_STOP=1 -c 'drop schema public'
 sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d hyperdata_core -vON_ERROR_STOP=1 < runtime/core/schema.sql
fi
sudo -u postgres psql -h /run/postgresql-hyperdata -p5545 -d hyperdata_core -vON_ERROR_STOP=1 < runtime/core/localize.sql
sudo python3 - <<'PY'
from pathlib import Path
import shlex,json,secrets,base64,hmac,hashlib,time,subprocess,re
base=Path('/etc/hyperdata')
def env(name):return dict(x.split('=',1) for x in shlex.split((base/name).read_text(),comments=True) if '=' in x)
def write(name,values):
 p=base/name;p.write_text(''.join(k+'='+json.dumps(v)+'\n' for k,v in values.items()));p.chmod(0o600)
api=env('api.env');owner=api['OWNER_ID'];assert re.fullmatch('[0-9a-f-]{36}',owner)
# Preserve one local signing identity and all existing feature flags on re-install.
secret=env('core.env')['LOCAL_JWT_SECRET'] if (base/'core.env').exists() else secrets.token_hex(48)
write('data.env',{'PGRST_JWT_SECRET':secret})
if not (base/'core.env').exists():
 def b64(b):return base64.urlsafe_b64encode(b).decode().rstrip('=')
 message=b64(b'{"alg":"HS256","typ":"JWT"}')+'.'+b64(json.dumps({'iss':'hyperdata-local','role':'service_role','iat':int(time.time())}).encode())
 token=message+'.'+b64(hmac.new(secret.encode(),message.encode(),hashlib.sha256).digest())
 write('core.env',{'LOCAL_DATA_URL':'http://local-data','LOCAL_DATA_SOCKET':'/run/hyperdata-data/rest.sock','LOCAL_SERVICE_TOKEN':token,'LOCAL_JWT_SECRET':secret,'OWNER_ID':owner,'OWNER_EMAIL':'jasonblick@zohomail.com','HYPERDATA_APP_ORIGIN':api['PUBLIC_ORIGIN'],'PAPER_TRADING_ENABLED':'true','PAPER_PROCESSOR_ENABLED':'true','STRATEGY_COMMAND_ENABLED':'true','STRATEGY_EXECUTION_ENABLED':'false','PAPER_SCHEDULER_SECRET':secrets.token_hex(32),'MONITOR_SECRET':secrets.token_hex(32)})
p=Path('/etc/hyperdata-data.conf');p.write_text('db-uri = "postgresql:///hyperdata_core?host=/run/postgresql-hyperdata&port=5545"\ndb-schemas = "public"\ndb-pool = 6\ndb-max-rows = 10000\nserver-unix-socket = "/run/hyperdata-data/rest.sock"\nserver-unix-socket-mode = "660"\nlog-level = "warn"\n');p.chmod(0o644)
subprocess.run(['runuser','-u','postgres','--','psql','-h','/run/postgresql-hyperdata','-p5545','-d','hyperdata_core','-vON_ERROR_STOP=1'],input=f"insert into auth.users(id,email,aud,role) values('{owner}','jasonblick@zohomail.com','authenticated','authenticated') on conflict(id) do nothing;",text=True,check=True)
for name in ['api.env','worker.env']:
 p=base/name;s='\n'.join(x for x in p.read_text().splitlines() if not x.startswith('LOCAL_CORE_ENABLED='));
 if name=='api.env' and 'OWNER_EMAIL=' not in s:s+='\nOWNER_EMAIL=jasonblick@zohomail.com'
 p.write_text(s+'\nLOCAL_CORE_ENABLED=true\n');p.chmod(0o600)
PY
bash scripts/install-owner-backend.sh
printf 'Local core database and identities configured. Deploy with scripts/deploy-alert-runtime.sh.\n'
