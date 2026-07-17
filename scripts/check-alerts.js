import nodemailer from "nodemailer";
import {
  ALERT_LABEL,
  TRIGGERED_LABEL,
  isAlertTriggered,
  parseAlertIssue,
} from "../public/lib/alerts.js";
import { fetchMarketsForDex } from "../public/lib/hyperliquid.js";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export async function checkAlerts({
  env = process.env,
  fetchImpl = fetch,
  mailer = null,
  smsSender = null,
  logger = console,
} = {}) {
  const config = readConfig(env);
  const github = createGitHubClient(config, fetchImpl);
  let transport = mailer;
  let textSender = smsSender;
  const issues = await github.listAlertIssues();
  const eligibleIssues = issues.filter(isEligibleIssue);

  if (!eligibleIssues.length) {
    logger.log("No eligible price alerts to check.");
    return { checked: 0, triggered: 0 };
  }

  const parsedIssues = eligibleIssues
    .map((issue) => ({ issue, alert: parseAlertIssue(issue.body) }))
    .filter(({ alert }) => alert);
  const markets = await loadRequiredMarkets(parsedIssues, fetchImpl);
  let triggered = 0;

  for (const { issue, alert } of parsedIssues) {
    const market = markets.get(alert.asset);
    if (!market?.markPrice || !isAlertTriggered(alert, market.markPrice)) continue;

    const originalLabels = issue.labels.map((label) =>
      typeof label === "string" ? label : label.name,
    );
    await github.setLabels(issue.number, [...new Set([...originalLabels, TRIGGERED_LABEL])]);

    try {
      if (alert.delivery === "sms") {
        requireSmsConfig(config);
        textSender ??= createSmsSender(config, fetchImpl);
        await sendAlertSms(textSender, config, issue, alert, market.markPrice);
      } else {
        requireEmailConfig(config);
        transport ??= createMailer(config);
        await sendAlertEmail(transport, config, issue, alert, market.markPrice);
      }
    } catch (error) {
      await github.setLabels(issue.number, originalLabels);
      throw error;
    }

    await github.comment(
      issue.number,
      `✅ ${alert.delivery === "sms" ? "Text message" : "Email"} sent to the configured recipient. **${alert.asset}** mark price was **${formatUsd(market.markPrice)}** at ${new Date().toISOString()}.`,
    );
    await github.close(issue.number);
    triggered += 1;
    logger.log(`Triggered #${issue.number}: ${alert.asset} ${alert.direction} ${alert.target}`);
  }

  logger.log(`Checked ${parsedIssues.length} alert(s); triggered ${triggered}.`);
  return { checked: parsedIssues.length, triggered };
}

export function isEligibleIssue(issue) {
  const labels = issue.labels.map((label) =>
    typeof label === "string" ? label : label.name,
  );
  return (
    !issue.pull_request &&
    TRUSTED_ASSOCIATIONS.has(issue.author_association) &&
    labels.includes(ALERT_LABEL) &&
    !labels.includes(TRIGGERED_LABEL)
  );
}

async function loadRequiredMarkets(parsedIssues, fetchImpl) {
  const dexIds = [...new Set(parsedIssues.map(({ alert }) => alert.dex))];
  const marketGroups = await Promise.all(
    dexIds.map((dex) => fetchMarketsForDex(dex, fetchImpl)),
  );
  return new Map(marketGroups.flat().map((market) => [market.id, market]));
}

function readConfig(env) {
  const missing = ["GITHUB_TOKEN", "GITHUB_REPOSITORY"]
    .filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    githubToken: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    alertEmail: env.ALERT_EMAIL,
    smtpHost: env.SMTP_HOST || "smtp.zoho.com",
    smtpPort: Number(env.SMTP_PORT || 465),
    smtpUsername: env.SMTP_USERNAME,
    smtpPassword: env.SMTP_PASSWORD,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    twilioFrom: env.TWILIO_FROM,
    alertSmsTo: env.ALERT_SMS_TO,
  };
}

function requireEmailConfig(config) {
  const missing = [
    ["ALERT_EMAIL", config.alertEmail],
    ["SMTP_USERNAME", config.smtpUsername],
    ["SMTP_PASSWORD", config.smtpPassword],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(`Cannot deliver a triggered alert; missing: ${missing.join(", ")}`);
  }
}

function createMailer(config) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUsername, pass: config.smtpPassword },
  });
}

function requireSmsConfig(config) {
  const missing = [
    ["TWILIO_ACCOUNT_SID", config.twilioAccountSid],
    ["TWILIO_AUTH_TOKEN", config.twilioAuthToken],
    ["TWILIO_FROM", config.twilioFrom],
    ["ALERT_SMS_TO", config.alertSmsTo],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(`Cannot deliver a triggered text alert; missing: ${missing.join(", ")}`);
  }
}

async function sendAlertEmail(transport, config, issue, alert, markPrice) {
  const symbol = alert.asset.split(":").at(-1);
  const subject = `Hyperdata alert: ${symbol} is ${alert.direction} ${formatUsd(alert.target)}`;
  const text = [
    `${alert.asset} has reached your target.`,
    "",
    `Current mark price: ${formatUsd(markPrice)}`,
    `Alert condition: ${alert.direction} ${formatUsd(alert.target)}`,
    `Triggered: ${new Date().toISOString()}`,
    "",
    `Alert issue: ${issue.html_url}`,
    "",
    "This was a one-time alert from Hyperdata.",
  ].join("\n");

  await transport.sendMail({
    from: `Hyperdata <${config.smtpUsername}>`,
    to: config.alertEmail,
    subject,
    text,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#171a20"><p style="font-size:12px;letter-spacing:.12em;color:#637080">HYPERDATA PRICE ALERT</p><h1 style="font-size:26px">${escapeHtml(alert.asset)} reached your target.</h1><p style="font-size:42px;font-weight:700;margin:24px 0">${formatUsd(markPrice)}</p><p>Condition: <strong>${escapeHtml(alert.direction)} ${formatUsd(alert.target)}</strong></p><p style="margin-top:28px"><a href="${issue.html_url}">View alert on GitHub</a></p><p style="margin-top:34px;color:#637080;font-size:12px">This was a one-time alert. Hyperdata is not financial advice.</p></div>`,
  });
}

function createSmsSender(config, fetchImpl) {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`;
  const authorization = Buffer
    .from(`${config.twilioAccountSid}:${config.twilioAuthToken}`)
    .toString("base64");

  return async (message) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: message.to,
        From: message.from,
        Body: message.body,
      }).toString(),
    });
    if (!response.ok) throw new Error(`Twilio SMS API returned ${response.status}`);
  };
}

async function sendAlertSms(smsSender, config, issue, alert, markPrice) {
  const symbol = alert.asset.split(":").at(-1);
  const body = [
    `Hyperdata: ${symbol} ${alert.direction} ${formatUsd(alert.target)}.`,
    `Mark: ${formatUsd(markPrice)}.`,
    issue.html_url,
  ].join(" ");

  await smsSender({ from: config.twilioFrom, to: config.alertSmsTo, body });
}

function createGitHubClient(config, fetchImpl) {
  async function request(path, options = {}) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${options.method ?? "GET"} ${path} returned ${response.status}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  const base = `/repos/${config.repository}`;
  return {
    listAlertIssues: () =>
      request(`${base}/issues?state=open&labels=${ALERT_LABEL}&per_page=100`),
    setLabels: (number, labels) =>
      request(`${base}/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify({ labels }),
      }),
    comment: (number, body) =>
      request(`${base}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    close: (number) =>
      request(`${base}/issues/${number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      }),
  };
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1 ? 2 : 8,
  }).format(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character],
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkAlerts().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
