import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requestSignInLink } from "../public/lib/auth.js";

test("public auth code excludes owner identity and privileged credentials", async () => {
  const browserCode = await Promise.all([
    readFile(new URL("../public/config.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  const publicAuthSource = browserCode.join("\n");

  assert.doesNotMatch(publicAuthSource, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  assert.doesNotMatch(publicAuthSource, /service[_-]?role/i);
  assert.doesNotMatch(publicAuthSource, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
});

test("sign-in requests use the dedicated delivery function", async () => {
  const calls = [];
  const client = { functions: { invoke: async (...args) => {
    calls.push(args);
    return { data: { status: "sent" }, error: null };
  } } };

  await requestSignInLink(client);

  assert.deepEqual(calls, [["send-login-link", { body: {} }]]);
});

test("sign-in requests expose a useful server rejection", async () => {
  const response = Response.json({ error: "please_wait", retryAfter: 10 }, { status: 429 });
  const client = { functions: { invoke: async () => ({ data: null, error: { context: response, message: "non-2xx" } }) } };

  await assert.rejects(requestSignInLink(client), /Wait 10 seconds before requesting another link/);
});

test("sign-in requests do not claim success without a sent receipt", async () => {
  const client = { functions: { invoke: async () => ({ data: {}, error: null }) } };
  await assert.rejects(requestSignInLink(client), /Unable to confirm sign-in email delivery/);
});
