import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthConfig,
  configureSupabaseAuth,
} from "../scripts/configure-supabase-auth.mjs";

const env = {
  SUPABASE_ACCESS_TOKEN: "management-token",
  SUPABASE_PROJECT_ID: "project-ref",
  SMTP_USERNAME: "sender@example.com",
  SMTP_PASSWORD: "app-password",
};

test("auth config uses Zoho submission TLS and a practical personal-app quota", () => {
  assert.deepEqual(buildAuthConfig(env), {
    site_url: "https://hypermizer.github.io/hyperdata/",
    smtp_admin_email: "sender@example.com",
    smtp_host: "smtp.zoho.com",
    smtp_port: "587",
    smtp_user: "sender@example.com",
    smtp_pass: "app-password",
    smtp_sender_name: "HYPERDATA",
    smtp_max_frequency: 10,
    rate_limit_email_sent: 100,
    rate_limit_otp: 100,
  });
});

test("auth configuration patches Supabase and reports only redacted settings", async () => {
  const calls = [];
  const messages = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method) {
      return Response.json({ smtp_host: "smtp.zoho.com", smtp_port: "465", smtp_user: "sender@example.com", smtp_pass: "hidden" });
    }
    return Response.json({ smtp_host: "smtp.zoho.com", smtp_port: "587", smtp_user: "sender@example.com", smtp_pass: "hidden" });
  };

  await configureSupabaseAuth({ env, fetchImpl, logger: { log: (message) => messages.push(message) } });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.supabase.com/v1/projects/project-ref/config/auth");
  assert.equal(calls[1].options.method, "PATCH");
  assert.equal(calls[1].options.headers.authorization, "Bearer management-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), buildAuthConfig(env));
  assert.match(messages.join("\n"), /smtp\.zoho\.com:465/);
  assert.match(messages.join("\n"), /smtp\.zoho\.com:587/);
  assert.doesNotMatch(messages.join("\n"), /app-password|hidden/);
});

test("auth configuration fails deployment when Supabase rejects the update", async () => {
  const fetchImpl = async (_url, options = {}) => options.method
    ? Response.json({ message: "invalid smtp" }, { status: 400 })
    : Response.json({ smtp_host: "smtp.zoho.com", smtp_port: "465" });

  await assert.rejects(
    configureSupabaseAuth({ env, fetchImpl, logger: { log() {} } }),
    /Unable to configure Supabase Auth \(400\): invalid smtp/,
  );
});
