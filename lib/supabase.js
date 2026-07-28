import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { browserSessionStorage, durableSessionOptions } from "./session.js?v=20260728-persistent-auth";

export function createWatchlistClient(config) {
  if (!config.supabaseUrl || !config.supabasePublishableKey) return null;
  const key = "__hyperdataSupabaseClient";
  if (!globalThis[key]) {
    globalThis[key] = createClient(
      config.supabaseUrl,
      config.supabasePublishableKey,
      durableSessionOptions(config.supabaseUrl, browserSessionStorage()),
    );
  }
  return globalThis[key];
}
