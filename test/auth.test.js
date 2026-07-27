import assert from "node:assert/strict";
import test from "node:test";
import { requestSignInLink } from "../public/lib/auth.js";

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
