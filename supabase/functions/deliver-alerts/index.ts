import { authorizeInternal } from "../_shared/auth.ts";
import { loadRuntimeConfig } from "../_shared/config.ts";
import { createServiceClient } from "../_shared/database.ts";
import { deliverPending } from "./service.ts";

export async function handleDelivery(request: Request): Promise<Response> {
  const config = loadRuntimeConfig(); const authError = authorizeInternal(request, config.monitorSecret); if (authError) return authError;
  if (!config.deliveryEnabled) return Response.json({ status: "delivery_disabled" });
  const client = createServiceClient(config.supabaseUrl, config.serviceRoleKey);
  try {
    return Response.json({ outcomes: await deliverPending(client) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
if (import.meta.main) Deno.serve(handleDelivery);
