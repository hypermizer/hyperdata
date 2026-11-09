#!/usr/bin/env python3
"""Update only Hyperdata's entries in the existing gateway working tree."""
from pathlib import Path
import difflib
import datetime

root = Path('/home/ubuntu/workspace/webapp')
backup = Path('/home/ubuntu/.local/state/hyperdata-gateway') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(parents=True, mode=0o700)
patches = []


def change(relative, mutate):
    path = root / relative
    before = path.read_text()
    after = mutate(before)
    if before == after:
        return
    saved = backup / relative
    saved.parent.mkdir(parents=True, exist_ok=True)
    saved.write_text(before)
    saved.chmod(0o600)
    path.write_text(after)
    patches.extend(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/'+relative, tofile='b/'+relative))


def config(text):
    start = text.index('    GatewayApp(\n        key="hyperdata",')
    end = text.index('    GatewayApp(', start + 16)
    return text[:start] + '''    GatewayApp(
        key="hyperdata",
        name="Hyperdata",
        href="https://3.131.225.164/",
        certificate_href="https://3.131.225.164/",
        tailscale_href="https://dev-mini-ohio.tail628a67.ts.net:8446/",
        description="Private Hyperliquid charts, liquidation levels, price alerts, and trading tools.",
        kind="local",
        service_unit="hyperdata-api.service",
        service_scope="system",
        notes="Hosted only on this server. Browser-certificate and owner Tailscale entrances use separate origins.",
    ),
''' + text[end:]


def server(text):
    if 'def hyperdata_launch(' in text:
        return text
    marker = '    @app.get("/healthz")'
    if marker not in text:
        raise RuntimeError('Gateway route layout changed; inspect before applying.')
    route = '''    @app.get("/hyperdata")
    @app.get("/hyperdata/")
    def hyperdata_launch():
        # The ordinary gateway authentication hook also protects this launch route.
        item = next(item for item in cfg.apps if item.key == "hyperdata")
        tailnet = request.host.split(":")[0] == "dev-mini-ohio.tail628a67.ts.net"
        return redirect(item.tailscale_href if tailnet else item.certificate_href, code=302)

'''
    return text.replace(marker, route + marker, 1)


change('ui/config.py', config)
change('ui/server.py', server)
change('frontend/src/App.vue', lambda text: text.replace('  if (app.key === "hyperdata") return "External site";\n', ''))
(backup / 'registration.patch').write_text(''.join(patches))
print('Updated Hyperdata gateway routes and both buttons; other working changes preserved.')
