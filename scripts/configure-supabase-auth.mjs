import { pathToFileURL } from "node:url";

const AUTH_CONFIG_URL = (projectRef) =>
  `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/auth`;

export function buildAuthConfig(env = process.env) {
  const smtpUser = required(env, "SMTP_USERNAME");
  return {
    site_url: "https://hypermizer.github.io/hyperdata/",
    smtp_admin_email: smtpUser,
    smtp_host: "smtp.zoho.com",
    smtp_port: "587",
    smtp_user: smtpUser,
    smtp_pass: required(env, "SMTP_PASSWORD"),
    smtp_sender_name: "HYPERDATA",
    smtp_max_frequency: 10,
    rate_limit_email_sent: 100,
    rate_limit_otp: 100,
  };
}

export async function configureSupabaseAuth({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const token = required(env, "SUPABASE_ACCESS_TOKEN");
  const projectRef = required(env, "SUPABASE_PROJECT_ID");
  const url = AUTH_CONFIG_URL(projectRef);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  const currentResponse = await fetchImpl(url, { headers });
  const current = await responseBody(currentResponse);
  if (!currentResponse.ok) {
    throw new Error(`Unable to inspect Supabase Auth (${currentResponse.status}): ${errorMessage(current)}`);
  }
  logger.log(`Current Supabase Auth SMTP: ${smtpSummary(current)}`);

  const desired = buildAuthConfig(env);
  const updateResponse = await fetchImpl(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(desired),
  });
  const updated = await responseBody(updateResponse);
  if (!updateResponse.ok) {
    throw new Error(`Unable to configure Supabase Auth (${updateResponse.status}): ${errorMessage(updated)}`);
  }
  logger.log(`Configured Supabase Auth SMTP: ${smtpSummary({ ...desired, ...updated })}`);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function errorMessage(body) {
  return body.message ?? body.error ?? JSON.stringify(body).slice(0, 300);
}

function smtpSummary(config) {
  const host = config.smtp_host || "default provider";
  const port = config.smtp_port ? `:${config.smtp_port}` : "";
  return `${host}${port}; custom user ${config.smtp_user ? "configured" : "absent"}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await configureSupabaseAuth();
}
