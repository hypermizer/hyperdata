import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchClaim, type ClaimedOutbox } from "./dispatcher.ts";
import { sendEmail } from "./email.ts";
import { sendSms } from "./sms.ts";
import { sendNtfy } from "./ntfy.ts";

function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function deliverPending(client: SupabaseClient) {
  const { data: claimed, error } = await client.rpc("claim_outbox", { p_limit: 10 });
  if (error) throw new Error(error.message);
  return await deliverClaims(client, (claimed ?? []) as ClaimedOutbox[]);
}

export async function deliverClaims(client: SupabaseClient, claimed: ClaimedOutbox[]) {
  return await Promise.all(claimed.map(async (row) => {
    try {
      const { data: occurrence, error: occurrenceError } = await client.from("alert_occurrences").select("*").eq("id", row.occurrence_id).single();
      if (occurrenceError) {
        throw new Error(occurrenceError.message);
      }
      const context = { asset: occurrence.asset, detector: occurrence.detector, markPrice: occurrence.mark_price, classification: occurrence.classification,
        evidence: occurrence.evidence, bucket: occurrence.bucket };
      const sender = row.channel === "ntfy"
        ? (message: { subject: string; text: string }) => sendNtfy({ baseUrl: env("NTFY_BASE_URL"), topic: env("NTFY_TOPIC"), token: Deno.env.get("NTFY_TOKEN") }, message)
        : row.channel === "email"
        ? (message: { subject: string; text: string }) => sendEmail({ host: Deno.env.get("ZOHO_SMTP_HOST") ?? "smtp.zoho.com", port: 465,
          user: env("ZOHO_SMTP_USER"), password: env("ZOHO_SMTP_PASSWORD"), from: Deno.env.get("ALERT_FROM") ?? `HYPERDATA <${env("ZOHO_SMTP_USER")}>`, to: "jasonblick@zohomail.com" }, message, row.id)
        : (message: { subject: string; text: string }) => sendSms({ accountSid: env("TWILIO_ACCOUNT_SID"), authToken: env("TWILIO_AUTH_TOKEN"),
          from: env("TWILIO_FROM_NUMBER"), to: env("ALERT_PHONE") }, message);
      return { id: row.id, state: await dispatchClaim(client, row, context, sender) };
    } catch {
      // A broken row must not prevent the other channel from being attempted.
      // Its expired lease is recovered by the next drain.
      return { id: row.id, state: "claimed", error: "Delivery processing failed; lease recovery pending" };
    }
  }));
}
