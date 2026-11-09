#!/usr/bin/env bash
set -euo pipefail
mountpoint -q /srv/hyperdata
exec 9>/run/lock/hyperdata-backup.lock
flock -n 9
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/srv/hyperdata/backups/alerts-${stamp}.dump"
trap 'rm -f "${target}.tmp"' EXIT
runuser -u postgres -- pg_dump -h /run/postgresql-hyperdata -p 5545 -d hyperdata -Fc >"${target}.tmp"
pg_restore --list "${target}.tmp" >/dev/null
mv "${target}.tmp" "$target"
sha256sum "$target" >"${target}.sha256"
aws s3 cp "$target" "s3://server-migration-280911663188-us-east-2/hyperdata/database/alerts-${stamp}.dump" --region us-east-2 --sse aws:kms --sse-kms-key-id arn:aws:kms:us-east-2:280911663188:key/70e270e0-b2cb-45dc-a177-417e92dce302 --only-show-errors
aws s3 cp "$target" "s3://server-migration-280911663188-ap-northeast-1/hyperdata/database/alerts-${stamp}.dump" --region ap-northeast-1 --sse aws:kms --sse-kms-key-id arn:aws:kms:ap-northeast-1:280911663188:key/282cc65c-bd6b-4d1b-b9d4-ba769f684630 --only-show-errors
find /srv/hyperdata/backups -maxdepth 1 -type f -name 'alerts-*.dump*' -mtime +7 -delete
printf 'Hyperdata backup verified and copied to Ohio and Tokyo: %s\n' "$stamp"
