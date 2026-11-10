#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v postgrest >/dev/null || { echo "Install the pinned local data API with scripts/install-postgrest.sh" >&2; exit 1; }
test_pg_bin=/usr/lib/postgresql/16/bin
core_test_dir=$(mktemp -d /tmp/hyperdata-core-test.XXXXXXXX)
cleanup() {
 if [[ -n "${rest_test_pid:-}" ]]; then kill "$rest_test_pid" 2>/dev/null || true; wait "$rest_test_pid" 2>/dev/null || true; fi
 "$test_pg_bin/pg_ctl" -D "$core_test_dir/data" -m immediate stop >/dev/null 2>&1 || true
 python3 -c 'import shutil,sys;shutil.rmtree(sys.argv[1])' "$core_test_dir"
}
trap cleanup EXIT
"$test_pg_bin/initdb" -D "$core_test_dir/data" -A trust --no-locale --encoding UTF8 >"$core_test_dir/init.log"
"$test_pg_bin/pg_ctl" -D "$core_test_dir/data" -l "$core_test_dir/server.log" -o "-k $core_test_dir -p 5547 -c listen_addresses=''" start >/dev/null
export PGHOST="$core_test_dir" PGPORT=5547 PGUSER="$(id -un)" PGDATABASE=postgres
export PGOPTIONS='-c search_path=public,extensions'
psql -X -vON_ERROR_STOP=1 >"$core_test_dir/setup.log" <<'SQL'
create role postgres nologin superuser;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role "hyperdata-rest" nologin noinherit;
\i runtime/core/bootstrap.sql
drop schema public;
\i runtime/core/schema.sql
set search_path=public,extensions;
create extension pgtap with schema extensions;
grant usage on schema extensions to anon;
select configure_paper_mutation_access(false);
insert into paper_processor_lease(singleton) values(true);
SQL
pg_prove supabase/tests/{paper*,strategy*,hyperliquid*,trade*,asset*,new_asset*,audio*}.sql
psql -X -vON_ERROR_STOP=1 -c "delete from paper_processor_lease" >>"$core_test_dir/setup.log"
psql -X -vON_ERROR_STOP=1 -f runtime/core/localize.sql >>"$core_test_dir/setup.log"
for migration in runtime/core/migrations/*.sql; do psql -X -vON_ERROR_STOP=1 -f "$migration" >>"$core_test_dir/setup.log"; done
pg_prove runtime/core/tests/*.sql

if command -v postgrest >/dev/null 2>&1; then
 export TEST_CORE_SECRET=local-test-secret-with-at-least-thirty-two-characters
 export TEST_CORE_SOCKET="$core_test_dir/rest.sock"
 psql -X -vON_ERROR_STOP=1 >>"$core_test_dir/setup.log" <<'SQL'
select configure_paper_mutation_access(true);
insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000777','jasonblick@zohomail.com');
SQL
 PGRST_DB_URI="postgresql:///postgres?host=$core_test_dir&port=5547&user=$(id -un)" PGRST_DB_SCHEMAS=public PGRST_JWT_SECRET="$TEST_CORE_SECRET" PGRST_SERVER_UNIX_SOCKET="$TEST_CORE_SOCKET" postgrest >"$core_test_dir/rest.log" 2>&1 &
 rest_test_pid=$!
 for attempt in {1..100}; do [[ ! -S "$TEST_CORE_SOCKET" ]] || break; sleep 0.1; done
 deno test --frozen --config supabase/functions/deno.json --allow-env --allow-net="unix:$TEST_CORE_SOCKET" --allow-read="$TEST_CORE_SOCKET" --allow-write="$TEST_CORE_SOCKET" runtime/core/tests/rest-integration.ts
fi
