import assert from "node:assert/strict";
import test from "node:test";
import { checkAlerts, isEligibleIssue } from "../scripts/check-alerts.js";
import { createAlertIssue } from "../public/lib/alerts.js";

const env = {
  GITHUB_TOKEN: "token",
  GITHUB_REPOSITORY: "owner/repo",
  ALERT_EMAIL: "alerts@example.com",
  SMTP_USERNAME: "sender@example.com",
  SMTP_PASSWORD: "secret",
};

test("only trusted, untriggered alert issues are eligible", () => {
  const base = { labels: [{ name: "price-alert" }], author_association: "OWNER" };
  assert.equal(isEligibleIssue(base), true);
  assert.equal(isEligibleIssue({ ...base, author_association: "NONE" }), false);
  assert.equal(isEligibleIssue({ ...base, pull_request: { url: "example" } }), false);
  assert.equal(
    isEligibleIssue({ ...base, labels: [...base.labels, { name: "alert-triggered" }] }),
    false,
  );
});

test("an empty alert queue does not require SMTP configuration", async () => {
  const result = await checkAlerts({
    env: {
      GITHUB_TOKEN: "token",
      GITHUB_REPOSITORY: "owner/repo",
    },
    fetchImpl: async () => jsonResponse([]),
    logger: { log() {} },
  });

  assert.deepEqual(result, { checked: 0, triggered: 0 });
});

test("triggered alert sends email, records the event, and closes the issue", async () => {
  const issueBody = createAlertIssue({
    asset: "xyz:ORCL",
    dex: "xyz",
    direction: "above",
    target: 200,
  }).body;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("api.hyperliquid.xyz")) {
      return jsonResponse([
        { universe: [{ name: "xyz:ORCL", maxLeverage: 10 }] },
        [{ markPx: "205", prevDayPx: "190" }],
      ]);
    }
    if (url.endsWith("issues?state=open&labels=price-alert&per_page=100")) {
      return jsonResponse([{ number: 7, body: issueBody, html_url: "https://github.com/owner/repo/issues/7", author_association: "OWNER", labels: [{ name: "price-alert" }] }]);
    }
    return jsonResponse({ ok: true });
  };
  const sent = [];
  const result = await checkAlerts({
    env,
    fetchImpl,
    mailer: { sendMail: async (message) => sent.push(message) },
    logger: { log() {} },
  });

  assert.deepEqual(result, { checked: 1, triggered: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "alerts@example.com");
  assert.match(sent[0].subject, /ORCL/);
  assert.equal(calls.filter((call) => call.options.method === "PATCH").length, 2);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 2);
});

test("triggered SMS alert sends a text through Twilio and closes the issue", async () => {
  const issueBody = createAlertIssue({
    asset: "xyz:ORCL",
    dex: "xyz",
    direction: "above",
    target: 200,
    delivery: "sms",
  }).body;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("api.hyperliquid.xyz")) {
      return jsonResponse([
        { universe: [{ name: "xyz:ORCL", maxLeverage: 10 }] },
        [{ markPx: "205", prevDayPx: "190" }],
      ]);
    }
    if (url.endsWith("issues?state=open&labels=price-alert&per_page=100")) {
      return jsonResponse([{ number: 9, body: issueBody, html_url: "https://github.com/owner/repo/issues/9", author_association: "OWNER", labels: [{ name: "price-alert" }] }]);
    }
    if (url.includes("api.twilio.com")) return jsonResponse({ sid: "SM123" }, 201);
    return jsonResponse({ ok: true });
  };
  const result = await checkAlerts({
    env: {
      GITHUB_TOKEN: "token",
      GITHUB_REPOSITORY: "owner/repo",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "secret",
      TWILIO_FROM: "+15555550100",
      ALERT_SMS_TO: "+15555550101",
    },
    fetchImpl,
    logger: { log() {} },
  });

  assert.deepEqual(result, { checked: 1, triggered: 1 });
  const smsCall = calls.find((call) => call.url.includes("api.twilio.com"));
  assert.equal(smsCall.options.method, "POST");
  assert.match(smsCall.options.headers.Authorization, /^Basic /);
  const body = new URLSearchParams(smsCall.options.body);
  assert.equal(body.get("To"), "+15555550101");
  assert.equal(body.get("From"), "+15555550100");
  assert.match(body.get("Body"), /ORCL/);
});

test("an alert below its target remains open", async () => {
  const issueBody = createAlertIssue({ asset: "xyz:ORCL", dex: "xyz", direction: "below", target: 100 }).body;
  const fetchImpl = async (url) => {
    if (url.includes("api.hyperliquid.xyz")) {
      return jsonResponse([{ universe: [{ name: "xyz:ORCL" }] }, [{ markPx: "150" }]]);
    }
    return jsonResponse([{ number: 8, body: issueBody, author_association: "OWNER", labels: [{ name: "price-alert" }] }]);
  };
  const result = await checkAlerts({ env, fetchImpl, mailer: { sendMail: async () => assert.fail("should not send") }, logger: { log() {} } });
  assert.deepEqual(result, { checked: 1, triggered: 0 });
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
