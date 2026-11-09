#!/usr/bin/env bash
set -euo pipefail
mountpoint -q /srv/hyperdata
exec 9>/run/lock/hyperdata-backup.lock
flock -n 9
umask 077
pg_bin=/usr/lib/postgresql/16/bin
stamp=$(date -u +%Y%m%dT%H%M%SZ)
copy_backup() {
 local backup_file="$1"
 aws s3 cp "$backup_file" "s3://server-migration-280911663188-us-east-2/hyperdata/database/$(basename "$backup_file")" --region us-east-2 --sse aws:kms --sse-kms-key-id arn:aws:kms:us-east-2:280911663188:key/70e270e0-b2cb-45dc-a177-417e92dce302 --only-show-errors
 aws s3 cp "$backup_file" "s3://server-migration-280911663188-ap-northeast-1/hyperdata/database/$(basename "$backup_file")" --region ap-northeast-1 --sse aws:kms --sse-kms-key-id arn:aws:kms:ap-northeast-1:280911663188:key/282cc65c-bd6b-4d1b-b9d4-ba769f684630 --only-show-errors
}
for database in hyperdata hyperdata_core; do
 if ! runuser -u postgres -- "$pg_bin/psql" -h /run/postgresql-hyperdata -p 5545 -d postgres -Atc "select 1 from pg_database where datname='$database'" | grep -qx 1; then
  if [[ "$database" == hyperdata ]] || [[ -f /etc/hyperdata/core.env ]]; then
   printf "Required Hyperdata database is unavailable: %s\n" "$database" >&2
   exit 1
  fi
  continue
 fi
 label=alerts
 [[ "$database" != hyperdata_core ]] || label=core
 target="/srv/hyperdata/backups/${label}-${stamp}.dump"
 runuser -u postgres -- "$pg_bin/pg_dump" -h /run/postgresql-hyperdata -p 5545 -d "$database" -Fc >"${target}.tmp"
 "$pg_bin/pg_restore" --list "${target}.tmp" >/dev/null
 mv "${target}.tmp" "$target"
 sha256sum "$target" >"${target}.sha256"
 copy_backup "$target"
 copy_backup "${target}.sha256"
done
config="/srv/hyperdata/backups/config-${stamp}.tar.gz"
tar -czf "$config" -C / etc/hyperdata etc/hyperdata-data.conf etc/postgresql/16/hyperdata
copy_backup "$config"
globals="/srv/hyperdata/backups/globals-${stamp}.sql"
runuser -u postgres -- "$pg_bin/pg_dumpall" -h /run/postgresql-hyperdata -p 5545 --globals-only > "$globals"
copy_backup "$globals"
find /srv/hyperdata/backups -maxdepth 1 -type f \( -name 'alerts-*.dump*' -o -name 'core-*.dump*' -o -name 'config-*.tar.gz' -o -name 'globals-*.sql' \) -mtime +7 -delete
printf 'Hyperdata databases and configuration backed up to Ohio and Tokyo: %s\n' "$stamp"
