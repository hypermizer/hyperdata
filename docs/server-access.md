# Server-only Hyperdata access

Hyperdata's app files run only on the Ohio server. Open its card in the Webapp gateway using either mode:

| Mode | Gateway | Hyperdata |
| --- | --- | --- |
| Tailscale | https://dev-mini-ohio.tail628a67.ts.net/ | https://dev-mini-ohio.tail628a67.ts.net:8446/ |
| Browser certificate | https://3.133.70.127/ | https://3.131.225.164/ |

iPhone ntfy notifications open the Tailscale Alerts page; external health probes retain the certificate endpoint.

Both entrances serve the same release, alert database, liquidation cache, and owner data. There is no separate Hyperdata sign-in, sign-out button, or email-link flow. The owner is configured server-side as the existing Jason account. The gateway's own login remains in place. The certificate entrance authenticates with the existing browser client CA; the Tailscale entrance requires the configured owner Tailscale identity and the existing gateway session.

The gateway's legacy `/hyperdata/` launch route selects the matching entrance. Assets, alerts, liquidation overlays, and other navigation remain within the selected Hyperdata origin. The dedicated desktop/terminal origins, terminal transports, and terminal-session revocation are unchanged.

## Tailscale boundary

Tailscale Serve exposes HTTPS port 8446 only inside the tailnet and forwards to `/run/hyperdata-tailnet/http.sock`. No Funnel/public publication is configured. The socket directory is private to the unprivileged `hyperdata-gateway` service and root/Tailscale. The bridge checks Serve's verified owner-login and forwarded HTTPS authority, validates the gateway cookie on every request, and requires the exact Hyperdata Tailscale Origin for mutations. Forged client identity and authorization headers are discarded. Gateway cookies are used only for the entrance authentication and are not forwarded to Hyperdata; only its CSRF cookie crosses that boundary.

The bridge connects to the existing certificate entrance with a dedicated client certificate and validates the upstream's public TLS certificate. Its outbound IPs are restricted to the public Hyperdata IP and loopback. Systemd supplies the root-protected client identity using `LoadCredential`; no owner browser private key is reused. A daily identity timer renews this client before 30 days remain, restarts the bridge, and revokes the previous fingerprint. API certificate revocation and health-only certificate restrictions apply to this client too.

The API permits exactly the certificate and Tailscale origins for writes and uses the shared secure CSRF nonce. The Tailscale and certificate entrances remain separate browser origins.

## Local owner data

All app storage and processors run on the Ohio server. The browser sends same-origin `/api/owner/` requests through the certificate/CSRF API to the separate `hyperdata-owner` service. That service signs a short-lived fixed-owner local JWT, forwards approved tables/RPCs to Unix-only PostgREST, and executes paper-command, news, and fundamentals handlers locally. Existing row policies and financial SQL functions still enforce ownership and ledger permissions. Hosted authentication, password login, and token refresh are not involved.

The `hyperdata_core` database holds the migrated application data; `hyperdata` continues to hold live alerts and liquidation caches. A non-inheriting PostgREST database role connects using peer authentication on the private PostgreSQL socket. Neither database nor PostgREST listens on TCP. Only the owner service and supervised core processors can reach the PostgREST socket; only the API can reach the owner-service socket. Signing and service credentials are root-protected and never reach the browser or certificate API.

The locally bundled protocol client stores no authentication session. Five-second paper account refreshes use the private API. Old public hosting, Supabase functions, and hosted schedules are retired; the former Data API exposes an empty schema. The paid Supabase project remains a frozen source archive, with mutation guards across all former app tables. See [local data operations](local-data.md).

## Public retirement and deployment

GitHub rejected the API request to deactivate Pages with HTTP 422. The former Pages branch now contains only an index/404 retirement notice pointing to the protected gateways. All app JavaScript, configuration, styles, and chart files were removed from that publication; `app.js` returns 404. `.github/workflows/deploy-pages.yml` is removed so normal changes cannot republish the app. The source repository remains available for version control; it contains no runtime secrets.

Provision access with `bash scripts/install-server-access.sh`, provision the private owner service with `bash scripts/install-owner-backend.sh`, then deploy with `bash scripts/deploy-alert-runtime.sh`. Register the gateway entries using `python3 scripts/register-hyperdata-gateway.py`, build its frontend from the webapp working directory, and gracefully reload the gateway. The registration script saves before-images and a narrow patch under `~/.local/state/hyperdata-gateway/`, preserving unrelated gateway working changes.

Configure Serve without resetting its other routes:

```bash
sudo tailscale serve --bg --https=8446 --yes unix:/run/hyperdata-tailnet/http.sock
sudo tailscale serve status
sudo systemctl status hyperdata-tailnet hyperdata-owner --no-pager
```

Never use `tailscale serve reset`; the existing gateway and phone terminal have their own routes. Secrets are root-only under `/etc/hyperdata/`, and application releases remain under `/opt/hyperdata-runtime/`. The API process has Unix sockets only and cannot read the owner service, SMTP, or 0xArchive credentials.

Validation includes certificate denial/revocation, Tailscale owner/session/Origin checks, header and cookie filtering, CSRF for both exact origins, owner-proxy path restrictions, both gateway buttons, launch routing, actual owner watchlist/paper reads without app sign-in, and alert create/delete through Tailscale with a deliberately unreachable threshold. No test liquidations or real paper trades are submitted. Existing alert health and notification queues are checked after deployment.
