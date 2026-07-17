import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

export function createWatchlistClient(config) {
  if (!config.supabaseUrl || !config.supabasePublishableKey) return null;
  return createClient(config.supabaseUrl, config.supabasePublishableKey);
}
