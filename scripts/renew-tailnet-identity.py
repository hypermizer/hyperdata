#!/usr/bin/env python3
"""Root-only rotation of the dedicated Hyperdata bridge client, never an owner key."""
from pathlib import Path
import secrets
import subprocess
import tempfile
import os

root = Path('/etc/hyperdata')
crt = root / 'tailnet-client.crt'
key = root / 'tailnet-client.key'


def run(args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL)


if crt.exists() and key.exists():
    if subprocess.run(['openssl','x509','-in',str(crt),'-noout','-checkend','2592000'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise SystemExit(0)
old = run(['openssl','x509','-in',str(crt),'-noout','-fingerprint','-sha1']).decode().strip().split('=')[1].replace(':','') if crt.exists() else None
with tempfile.TemporaryDirectory(prefix='hyperdata-identity-',dir='/run') as work:
    folder = Path(work)
    run(['openssl','req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=Hyperdata Tailnet Bridge','-keyout',str(folder/'key'),'-out',str(folder/'csr')])
    (folder/'ext').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n')
    run(['openssl','x509','-req','-in',str(folder/'csr'),'-CA','/etc/nginx/mtls/ca.crt','-CAkey','/etc/nginx/mtls/ca.key','-set_serial','0x'+secrets.token_hex(16),'-days','365','-sha256','-extfile',str(folder/'ext'),'-out',str(folder/'crt')])
    for source,target in [('key',key),('crt',crt)]:
        temporary=target.with_suffix(target.suffix+'.next')
        descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(descriptor,'wb') as output:output.write((folder/source).read_bytes())
        temporary.replace(target)
if subprocess.run(['systemctl','is-active','--quiet','hyperdata-tailnet']).returncode == 0:
    subprocess.run(['systemctl','restart','hyperdata-tailnet'],check=True)
if old:
    subprocess.run(['runuser','-u','hyperdata','--','psql','-h','/run/postgresql-hyperdata','-p','5545','-d','hyperdata','-v','ON_ERROR_STOP=1','-c',
        "insert into revoked_clients(fingerprint) values('"+old+"') on conflict do nothing"],check=True,stdout=subprocess.DEVNULL)
print('Dedicated Hyperdata Tailscale client identity installed.')
