#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_pg_dir=$(mktemp -d /tmp/hyperdata-runtime-test.XXXXXXXX)
test_pg_bin=$(pg_config --bindir)
if ! test -x "$test_pg_bin/initdb"; then
 test_pg_bin=$(find /usr/lib/postgresql -path "*/bin/initdb" -type f | sort -V | tail -1 | xargs dirname)
fi
cleanup() {
  "$test_pg_bin/pg_ctl" -D "$test_pg_dir/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$test_pg_dir"
}
trap cleanup EXIT
chmod 700 "$test_pg_dir"
"$test_pg_bin/initdb" -D "$test_pg_dir/data" -A trust --no-locale --encoding UTF8 >"$test_pg_dir/init.log"
"$test_pg_bin/pg_ctl" -D "$test_pg_dir/data" -l "$test_pg_dir/server.log" -o "-k $test_pg_dir -p 5546 -c listen_addresses=''" start >/dev/null
TEST_PGHOST="$test_pg_dir" TEST_PGPORT=5546 TEST_PGUSER="$(id -un)" \
  deno test --config supabase/functions/deno.json --allow-env --allow-read="runtime,$test_pg_dir" --allow-write="$test_pg_dir" \
  --allow-net="unix:$test_pg_dir/.s.PGSQL.5546" runtime/tests/
