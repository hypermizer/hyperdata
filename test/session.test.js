import assert from "node:assert/strict";
import test from "node:test";
import {
  durableSessionOptions,
  hasAuthCallbackParameters,
  sessionStorageKey,
} from "../public/lib/session.js";

test("durable browser sessions retain Supabase's existing storage key", () => {
  const storage = { getItem() {}, setItem() {}, removeItem() {} };
  assert.equal(
    sessionStorageKey("https://itheknkmuutquriojdzt.supabase.co"),
    "sb-itheknkmuutquriojdzt-auth-token",
  );
  assert.deepEqual(durableSessionOptions("https://itheknkmuutquriojdzt.supabase.co", storage), {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "implicit",
      storageKey: "sb-itheknkmuutquriojdzt-auth-token",
      storage,
    },
  });
});

test("auth callbacks are protected from hash routing until consumed", () => {
  assert.equal(hasAuthCallbackParameters({
    hash: "#access_token=access&refresh_token=refresh&type=magiclink",
    search: "",
  }), true);
  assert.equal(hasAuthCallbackParameters({ hash: "", search: "?code=pkce-code" }), true);
  assert.equal(hasAuthCallbackParameters({ hash: "#paper/account/order", search: "" }), false);
});
