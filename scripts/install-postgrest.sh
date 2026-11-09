#!/usr/bin/env bash
set -euo pipefail
if [[ "$(/usr/local/bin/postgrest --version 2>/dev/null || true)" == 'PostgREST 16.5' ]]; then exit 0; fi
install_dir=$(mktemp -d /tmp/hyperdata-postgrest-install.XXXXXXXX)
trap 'python3 -c '\''import shutil,sys;shutil.rmtree(sys.argv[1])'\'' "$install_dir"' EXIT
curl -fsSL https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-linux-static-x86-64.tar.xz -o "$install_dir/postgrest.tar.xz"
printf '%s  %s\n' 5099e7ada38f9f6846cd87c14c5f158b7c165f1e9959665ad412e61f4dceba95 "$install_dir/postgrest.tar.xz" | sha256sum -c -
tar -xJf "$install_dir/postgrest.tar.xz" -C "$install_dir"
sudo install -m0755 "$install_dir/postgrest" /usr/local/bin/postgrest
