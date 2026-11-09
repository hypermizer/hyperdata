import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDataFetch } from "./local-data.ts";
export function createServiceClient(
  url: string,
  serviceRoleKey: string,
): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(Deno.env.get("LOCAL_DATA_SOCKET")
      ? {
        global: { fetch: localDataFetch(Deno.env.get("LOCAL_DATA_SOCKET")!) },
      }
      : {}),
  });
}
