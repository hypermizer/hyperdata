export interface RuntimeConfig { supabaseUrl: string; serviceRoleKey: string; monitorSecret: string; deliveryEnabled: boolean }
function required(name: string, env: Record<string, string | undefined>): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export function loadRuntimeConfig(env: Record<string, string | undefined> = Deno.env.toObject()): RuntimeConfig {
  return {
    supabaseUrl: required("SUPABASE_URL", env), serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY", env),
    monitorSecret: required("MONITOR_SECRET", env), deliveryEnabled: env.DELIVERY_ENABLED === "true",
  };
}
