import { authorizeInternal } from "../_shared/auth.ts";
import { loadRuntimeConfig } from "../_shared/config.ts";
import { createServiceClient } from "../_shared/database.ts";
import { dispatchClaim, type ClaimedOutbox } from "./dispatcher.ts";
import { sendEmail } from "./email.ts";
import { sendSms } from "./sms.ts";

function env(name: string): string { const value = Deno.env.get(name)?.trim(); if (!value) throw new Error(`Missing ${name}`); return value; }
export async function handleDelivery(request: Request): Promise<Response> {
  const config = loadRuntimeConfig(); const authError = authorizeInternal(request, config.monitorSecret); if (authError) return authError;
  if (!config.deliveryEnabled) return Response.json({ status: "delivery_disabled" });
  const client = createServiceClient(config.supabaseUrl, config.serviceRoleKey);
  const { data: claimed, error } = await client.rpc("claim_outbox", { p_limit: 3 }); if (error) return Response.json({ error: error.message }, { status: 500 });
  const outcomes = [];
  for (const row of (claimed ?? []) as ClaimedOutbox[]) {
    const { data: occurrence, error: occurrenceError } = await client.from("alert_occurrences").select("*").eq("id", row.occurrence_id).single();
    if (occurrenceError) { outcomes.push({ id: row.id, state: "claimed", error: occurrenceError.message }); continue; }
    const context = { asset: occurrence.asset, detector: occurrence.detector, markPrice: occurrence.mark_price, classification: occurrence.classification,
      evidence: occurrence.evidence, bucket: occurrence.bucket };
    const sender = row.channel === "email"
      ? (message: { subject: string; text: string }) => sendEmail({ host: Deno.env.get("ZOHO_SMTP_HOST") ?? "smtp.zoho.com", port: 465,
        user: env("ZOHO_SMTP_USER"), password: env("ZOHO_SMTP_PASSWORD"), from: Deno.env.get("ALERT_FROM") ?? `HYPERDATA <${env("ZOHO_SMTP_USER")}>`, to: env("ALERT_EMAIL") }, message)
      : (message: { subject: string; text: string }) => sendSms({ accountSid: env("TWILIO_ACCOUNT_SID"), authToken: env("TWILIO_AUTH_TOKEN"),
        from: env("TWILIO_FROM_NUMBER"), to: env("ALERT_PHONE") }, message);
    outcomes.push({ id: row.id, state: await dispatchClaim(client, row, context, sender) });
  }
  return Response.json({ outcomes });
}
if (import.meta.main) Deno.serve(handleDelivery);
