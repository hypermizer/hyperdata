# Hyperdata

Hyperdata is a free, GitHub-hosted dashboard for monitoring Hyperliquid perpetual markets and creating one-time mark-price email alerts. It supports the default perp DEX and HIP-3 markets such as `xyz:ORCL` and `xyz:XYZ100`.

## How it works

- The dashboard is a static site deployed with GitHub Pages.
- It reads public market contexts directly from Hyperliquid's `metaAndAssetCtxs` API.
- Your watchlist is stored only in your browser's local storage.
- Creating an alert opens a prefilled GitHub issue. Submitting that issue activates the alert; closing it cancels the alert.
- A scheduled GitHub Action checks open alert issues every five minutes. Once a target is met, it sends one email, comments on the issue, and closes it.
- Only alerts opened by the repository owner, a member, or a collaborator are processed, preventing public issue spam from sending email.

## One-time setup

The site deploys automatically after the repository is pushed to GitHub. Email delivery needs three repository secrets:

1. In Zoho Mail, enable two-factor authentication and create an application-specific password.
2. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
3. Add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `ALERT_EMAIL` | The address that receives alerts |
   | `SMTP_USERNAME` | The full Zoho Mail sending address |
   | `SMTP_PASSWORD` | The Zoho application-specific password |

The workflow defaults to `smtp.zoho.com` on port `465`. Accounts hosted in another Zoho data center can change `SMTP_HOST` in [`.github/workflows/monitor-alerts.yml`](.github/workflows/monitor-alerts.yml).

After adding the secrets, run **Actions → Monitor price alerts → Run workflow** once. A run with no active alerts should finish successfully.

## Local development

```bash
npm install
npm test
npm run serve
```

Then open the local URL printed by `serve`.

## Alert lifecycle

1. Choose a watched asset, direction, and target on the dashboard.
2. Click **Create alert on GitHub**.
3. Review and submit the prefilled issue. Do not edit the hidden `hyperdata-alert` block.
4. The scheduled monitor evaluates the asset's mark price. GitHub schedules can occasionally be delayed.
5. When the condition is met, Hyperdata emails the configured recipient and closes the issue.

Alerts are one-time notifications. They are not guaranteed execution signals and should not be used as a substitute for exchange-native risk controls.

GitHub automatically disables scheduled workflows in public repositories after 60 days without repository activity. If this repository is idle for that long, re-enable **Monitor price alerts** in the Actions tab before relying on alerts again.

## Commands

- `npm test` — run the alert and API unit tests
- `npm run check` — syntax-check browser and monitor JavaScript
- `npm run alerts` — run the monitor (requires the workflow environment variables)
- `npm run serve` — serve the dashboard locally

## Data and privacy

The dashboard does not collect wallet data or credentials. Active alert conditions are public because they are GitHub issues in a public repository. Email and SMTP credentials are encrypted GitHub Actions secrets and never shipped to the browser.

Market data comes from Hyperliquid. Hyperdata is an independent project and is not affiliated with Hyperliquid. Nothing here is financial advice.
