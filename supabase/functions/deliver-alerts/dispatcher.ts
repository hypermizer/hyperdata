import type { SupabaseClient } from "@supabase/supabase-js";
import { buildNotification, type NotificationContext } from "./templates.ts";

export interface ClaimedOutbox { id: string; occurrence_id: string; channel: "email" | "sms" | "ntfy"; attempts: number }
export type Sender = (message: { subject: string; text: string }) => Promise<{ providerId: string | null }>;

async function finalize(client: SupabaseClient, parameters: Record<string, unknown>) {
  const { data, error } = await client.rpc("finalize_outbox", parameters);
  if (error || !data) throw new Error(error?.message ?? "Outbox claim was no longer active");
}

function isAmbiguous(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|abort|connection closed|fetch failed/i.test(text);
}
export async function dispatchClaim(client: SupabaseClient, row: ClaimedOutbox, context: NotificationContext, sender: Sender) {
  let result: { providerId: string | null };
  try {
    result = await sender(buildNotification(context));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); const ambiguous = isAmbiguous(error);
    const retry = row.attempts < 12;
    const state = retry ? "retry_wait" : ambiguous ? "ambiguous" : "failed";
    const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, row.attempts - 1));
    await finalize(client, { p_id: row.id, p_attempt: row.attempts, p_state: state, p_provider_id: null, p_error: message,
      p_next_attempt_at: retry ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null });
    return state;
  }
  try {
    await finalize(client, { p_id: row.id, p_attempt: row.attempts, p_state: "sent", p_provider_id: result.providerId, p_error: null, p_next_attempt_at: null });
    return "sent";
  } catch (error) {
    await finalize(client, { p_id: row.id, p_attempt: row.attempts, p_state: "ambiguous", p_provider_id: result.providerId,
      p_error: `Provider accepted delivery but state finalization failed: ${error instanceof Error ? error.message : String(error)}`, p_next_attempt_at: null });
    return "ambiguous";
  }
}
