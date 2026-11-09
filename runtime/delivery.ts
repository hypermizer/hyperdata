import { AlertStore, type LocalDelivery } from "./store.ts";
import { sendEmail } from "../supabase/functions/deliver-alerts/email.ts";
import { sendNtfy } from "../supabase/functions/deliver-alerts/ntfy.ts";
import { buildNotification } from "../supabase/functions/deliver-alerts/templates.ts";

const required = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing ${name}`);
  return v;
};
export type LocalSender = (
  row: LocalDelivery,
  message: { subject: string; text: string },
) => Promise<{ providerId: string | null }>;
export const providerSender: LocalSender = (row, message) =>
  row.channel === "ntfy"
    ? sendNtfy({
      baseUrl: required("NTFY_BASE_URL"),
      topic: required("NTFY_TOPIC"),
      token: Deno.env.get("NTFY_TOKEN"),
      clickUrl: required("PUBLIC_ORIGIN") + "/#/alerts",
    }, message)
    : sendEmail(
      {
        host: Deno.env.get("ZOHO_SMTP_HOST") ?? "smtp.zoho.com",
        port: 465,
        user: required("ZOHO_SMTP_USER"),
        password: required("ZOHO_SMTP_PASSWORD"),
        from: `HYPERDATA <${required("ZOHO_SMTP_USER")}>`,
        to: "jasonblick@zohomail.com",
      },
      message,
      row.id,
    );
export async function deliverRow(
  store: Pick<AlertStore, "finish">,
  row: LocalDelivery,
  sender: LocalSender = providerSender,
) {
  const o = row.occurrence;
  let providerId: string | null;
  try {
    const message = buildNotification({
      asset: o.asset,
      detector: o.detector,
      markPrice: o.mark_price,
      classification: o.classification,
      evidence: o.evidence,
      bucket: o.bucket,
    });
    const observed = Date.parse(String(o.evidence.observedAt ?? o.bucket));
    if (Date.now() - observed > 60_000) {
      message.subject += " · delayed delivery";
      message.text +=
        "\nDelivery was delayed. The price above is the recorded trigger price.";
    }
    providerId = (await sender(row, message)).providerId;
  } catch (error) {
    const ambiguous = /timeout|timed out|abort|ECONNRESET|fetch failed/i.test(
      error instanceof Error ? error.message : String(error),
    );
    const retry = row.attempts < 288,
      state = retry ? "retry_wait" : ambiguous ? "ambiguous" : "failed";
    const delay = Math.min(300, 5 * 2 ** Math.min(10, row.attempts - 1));
    await store.finish(
      row,
      state,
      null,
      `${row.channel} provider did not confirm delivery${
        ambiguous ? " (network outcome uncertain)" : ""
      }`,
      retry ? new Date(Date.now() + delay * 1000).toISOString() : null,
    );
    return state;
  }
  try {
    if (await store.finish(row, "sent", providerId, null, null)) return "sent";
  } catch {
    /* Keep the lease if persistence failed; recovery is at-least-once. */
  }
  try {
    await store.finish(
      row,
      "ambiguous",
      providerId,
      "Provider accepted; finalization unconfirmed.",
      null,
    );
  } catch { /* lease recovery */ }
  return "ambiguous";
}
export async function drainDeliveries(
  store: AlertStore,
  sender: LocalSender = providerSender,
) {
  if (Deno.env.get("DELIVERY_ENABLED") !== "true") return [];
  const groups = await Promise.all(
    (["ntfy", "email"] as const).map(async (channel) => {
      const rows = await store.claim(channel);
      return await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          channel,
          state: await deliverRow(store, row, sender),
        })),
      );
    }),
  );
  return groups.flat();
}
