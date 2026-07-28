export function sessionStorageKey(supabaseUrl) {
  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  return `sb-${projectRef}-auth-token`;
}

export function durableSessionOptions(supabaseUrl, storage) {
  return {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "implicit",
      storageKey: sessionStorageKey(supabaseUrl),
      ...(storage ? { storage } : {}),
    },
  };
}

export function browserSessionStorage(scope = globalThis) {
  try { return scope.localStorage; }
  catch { return undefined; }
}

export function hasAuthCallbackParameters(location = globalThis.location) {
  const hash = new URLSearchParams(String(location?.hash ?? "").replace(/^#/, ""));
  const search = new URLSearchParams(String(location?.search ?? "").replace(/^\?/, ""));
  return ["access_token", "refresh_token", "error", "error_code", "error_description"].some((key) => hash.has(key))
    || ["code", "token_hash"].some((key) => search.has(key));
}
