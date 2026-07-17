# Hyperdata

Personal Hyperliquid price monitor. Current scope: watchlist prices and one-time email or text alerts for assets such as `xyz:ORCL` and `xyz:XYZ100`.

## How it works

- The dashboard is a static site deployed with GitHub Pages.
- The Watchlist tab receives mark price, 24-hour volume, and open interest from Hyperliquid's live WebSocket feed. Average volume is derived from daily candles and refreshed every five minutes in USD.
- The watchlist is stored per signed-in user in Supabase, so changes made in the UI follow you across browsers and devices.
- Creating an alert opens a prefilled GitHub issue. Submitting that issue activates the alert; closing it cancels the alert.
- A scheduled GitHub Action checks open alert issues every five minutes. Once a target is met, it sends one email or text, comments on the issue, and closes it.
- Only alerts opened by the repository owner, a member, or a collaborator are processed, preventing public issue spam from sending email.

## One-time setup

The site deploys automatically after the repository is pushed to GitHub. Configure only the services you use.

### Watchlist storage (Supabase)

1. Create a Supabase project and open its **SQL Editor**.
2. Run [`supabase/schema.sql`](supabase/schema.sql).
3. In **Authentication → URL Configuration**, set both the Site URL and an allowed Redirect URL to `https://hypermizer.github.io/hyperdata/`.
4. In **Project Settings → API**, copy the Project URL and Publishable key into [`public/config.js`](public/config.js):

   ```js
   supabaseUrl: "https://your-project.supabase.co",
   supabasePublishableKey: "your-publishable-key",
   ```

5. Deploy the updated config. Click **Sign in** in Hyperdata and open the emailed sign-in link in the same browser.

The Publishable key is intended for browser apps. Never put a Supabase secret or service-role key in this repository. The supplied policy permits only `jasonblick@zohomail.com` to read or change this watchlist.

### Email (Zoho)

1. In Zoho Mail, enable two-factor authentication and create an application-specific password.
2. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
3. Add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `ALERT_EMAIL` | The address that receives alerts |
   | `SMTP_USERNAME` | The full Zoho Mail sending address |
   | `SMTP_PASSWORD` | The Zoho application-specific password |

The workflow defaults to `smtp.zoho.com` on port `465`. Accounts hosted in another Zoho data center can change `SMTP_HOST` in [`.github/workflows/monitor-alerts.yml`](.github/workflows/monitor-alerts.yml).

### Text messages (Twilio)

1. Create a Twilio account and get an SMS-capable sender number. Complete any registration Twilio requires for your country and sender type.
2. In **Settings → Secrets and variables → Actions**, add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `TWILIO_ACCOUNT_SID` | Twilio Account SID |
   | `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
   | `TWILIO_FROM` | Your Twilio sender number in E.164 format, e.g. `+15555550100` |
   | `ALERT_SMS_TO` | Your receiving phone number in E.164 format |

The phone number stays in a GitHub secret; it is never placed in the public alert issue or browser code. Twilio charges for SMS; GitHub hosting and Actions are still free within their applicable allowances.

After adding the secrets, run **Actions → Monitor price alerts → Run workflow** once. A run with no active alerts should finish successfully.

## Local development

```bash
npm install
npm test
npm run serve
```

Then open the local URL printed by `serve`.

## Alert lifecycle

1. Choose a watched asset, direction, target, and delivery method on the dashboard.
2. Click **Create alert on GitHub**.
3. Review and submit the prefilled issue. Do not edit the hidden `hyperdata-alert` block.
4. The scheduled monitor evaluates the asset's mark price. GitHub schedules can occasionally be delayed.
5. When the condition is met, Hyperdata delivers the selected email or text alert and closes the issue.

Alerts are one-time notifications. They are not guaranteed execution signals and should not be used as a substitute for exchange-native risk controls.

GitHub automatically disables scheduled workflows in public repositories after 60 days without repository activity. If this repository is idle for that long, re-enable **Monitor price alerts** in the Actions tab before relying on alerts again.

## Commands

- `npm test` — run the alert and API unit tests
- `npm run check` — syntax-check browser and monitor JavaScript
- `npm run alerts` — run the monitor (requires the workflow environment variables)
- `npm run serve` — serve the dashboard locally

## Notes

Active alert conditions are public GitHub issues. Email, Twilio, and phone credentials are GitHub Actions secrets and never ship to the browser.
