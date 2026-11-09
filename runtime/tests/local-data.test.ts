import { assertEquals } from "@std/assert";
import {
  localDataFetch,
  signLocalToken,
  verifyLocalOwner,
} from "../../supabase/functions/_shared/local-data.ts";
Deno.test("local owner JWT rejects forgery, expiry, another owner, and service identities", async () => {
  const secret = "test-local-owner-key-long-enough-for-hmac",
    owner = "owner-id",
    email = "owner@example.com",
    now = 1_800_000_000_000;
  const claims = { sub: owner, email, role: "authenticated" };
  const token = await signLocalToken(secret, claims, now);
  assertEquals(await verifyLocalOwner(token, secret, owner, email, now), {
    id: owner,
    email,
  });
  for (
    const [candidate, key, id, mail, time] of [
      [token, "wrong-secret", owner, email, now],
      [token, secret, "other", email, now],
      [token, secret, owner, "other@example.com", now],
      [token, secret, owner, email, now + 3600001],
      [
        await signLocalToken(secret, { ...claims, role: "service_role" }, now),
        secret,
        owner,
        email,
        now,
      ],
      [token + ".extra", secret, owner, email, now],
    ] as [string, string, string, string, number][]
  ) assertEquals(await verifyLocalOwner(candidate, key, id, mail, time), null);
});
Deno.test("local data client rejects external destinations before opening a socket", async () => {
  for (
    const url of [
      "https://example.com/rest/v1/paper_accounts",
      "http://local-data/auth/v1/users",
    ]
  ) {
    let failed = false;
    try {
      await localDataFetch("/invalid")(url);
    } catch {
      failed = true;
    }
    assertEquals(failed, true);
  }
});
