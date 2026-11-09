"""Owner-only Tailscale ingress. The certificate origin remains independently mTLS protected."""
import os
import secrets
import ssl
import re
from http.cookies import SimpleCookie
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, DummyCookieJar, TCPConnector, web

TAILNET_HOST = "dev-mini-ohio.tail628a67.ts.net:8446"
TAILNET_ORIGIN = "https://" + TAILNET_HOST
GATEWAY_ORIGIN = "https://dev-mini-ohio.tail628a67.ts.net"
UPSTREAM = "https://3.131.225.164"
HOP = {"connection", "upgrade", "proxy-connection", "keep-alive", "transfer-encoding", "te", "trailer", "proxy-authenticate", "proxy-authorization", "host", "content-length", "authorization", "cookie"}


def valid_identity(headers, owner):
    # Serve replaces the backend Host for a Unix socket; its authenticated
    # X-Forwarded-Host carries the original HTTPS authority.
    return (headers.get("X-Forwarded-Host") == TAILNET_HOST
            and secrets.compare_digest(headers.get("Tailscale-User-Login", ""), owner))


async def proxy(request):
    if not valid_identity(request.headers, request.app["owner"]):
        raise web.HTTPForbidden(text="Your authorized Tailscale account is required.")
    origin = request.headers.get("Origin")
    if origin not in (None, TAILNET_ORIGIN):
        raise web.HTTPForbidden(text="Origin rejected.")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin != TAILNET_ORIGIN:
        raise web.HTTPForbidden(text="Origin required.")
    # Authenticate with the same cookie and gateway login as the other private apps.
    async with request.app["auth"].get("http://127.0.0.1:8079/auth/check", headers={
        "Cookie": request.headers.get("Cookie", ""), "X-Forwarded-Proto": "https"
    }, allow_redirects=False) as auth:
        if auth.status != 204:
            if request.path.startswith("/api/"):
                return web.json_response({"error": "Open the gateway and sign in to continue.", "gateway": GATEWAY_ORIGIN}, status=401)
            raise web.HTTPFound(GATEWAY_ORIGIN + "/login")
    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in HOP and not k.lower().startswith(("tailscale-", "x-hyperdata-", "x-forwarded-"))}
    headers["Host"] = "3.131.225.164"
    # Gateway cookies authenticate the entrance only; never expose them to the app.
    cookies = SimpleCookie()
    cookies.load(request.headers.get('Cookie', ''))
    csrf = cookies.get('__Host-hyperdata-csrf')
    if csrf and re.fullmatch(r'[a-fA-F0-9-]{72}', csrf.value):
        headers['Cookie'] = '__Host-hyperdata-csrf=' + csrf.value
    async with request.app["upstream"].request(request.method, UPSTREAM + request.raw_path,
            headers=headers, data=request.content.iter_chunked(16384), allow_redirects=False) as upstream:
        response = web.StreamResponse(status=upstream.status)
        for key, value in upstream.headers.items():
            if key.lower() == 'set-cookie' and not value.startswith('__Host-hyperdata-csrf='):
                continue
            if key.lower() not in HOP:
                response.headers.add(key, value)
        response.headers["Cache-Control"] = "no-store"
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(65536):
            await response.write(chunk)
        return response


@web.middleware
async def safe_errors(request, handler):
    try:
        return await handler(request)
    except web.HTTPException as error:
        error.headers["Cache-Control"] = "no-store"
        raise
    except Exception:
        return web.json_response({"error": "Private Hyperdata is temporarily unavailable."}, status=502, headers={"Cache-Control": "no-store"})


async def lifecycle(app):
    credentials = Path(os.environ["CREDENTIALS_DIRECTORY"])
    context = ssl.create_default_context()
    context.load_cert_chain(credentials / "client.crt", credentials / "client.key")
    async with ClientSession(cookie_jar=DummyCookieJar(), timeout=ClientTimeout(total=10)) as auth:
        async with ClientSession(cookie_jar=DummyCookieJar(), connector=TCPConnector(ssl=context),
                timeout=ClientTimeout(total=40, sock_connect=10), auto_decompress=False) as upstream:
            app["auth"] = auth
            app["upstream"] = upstream
            yield


def create_app(owner):
    app = web.Application(middlewares=[safe_errors], client_max_size=16_384)
    app["owner"] = owner
    app.cleanup_ctx.append(lifecycle)
    app.router.add_route("*", "/{path:.*}", proxy)
    return app


if __name__ == "__main__":
    web.run_app(create_app(os.environ["TAILNET_OWNER_LOGIN"]),
        path="/run/hyperdata-tailnet/http.sock", print=None, access_log=None, shutdown_timeout=5)
