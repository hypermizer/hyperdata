import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "../deliver-alerts/email.ts";
import { sendNtfy } from "../deliver-alerts/ntfy.ts";

export async function checkPriceAlertHealth(client: SupabaseClient) {
  const { data, error } = await client.rpc("claim_price_alert_incident");
  if (error) throw new Error("Price alert watchdog query failed");
  if (!data) return null;
  const message = { subject: "HYPERDATA · price alert service status", text: String(data) };
  const user = Deno.env.get("ZOHO_SMTP_USER") ?? "";
  const outcomes = await Promise.allSettled([
    sendNtfy({ baseUrl: Deno.env.get("NTFY_BASE_URL") ?? "", topic: Deno.env.get("NTFY_TOPIC") ?? "", token: Deno.env.get("NTFY_TOKEN") }, message),
    sendEmail({ host: Deno.env.get("ZOHO_SMTP_HOST") ?? "smtp.zoho.com", port: 465, user,
      password: Deno.env.get("ZOHO_SMTP_PASSWORD") ?? "", from: `HYPERDATA <${user}>`, to: "jasonblick@zohomail.com" }, message),
  ]);
  return { notice: String(data), acceptedChannels: outcomes.map((result, i) => result.status === "fulfilled" ? ["ntfy", "email"][i] : null).filter(Boolean) };
}
