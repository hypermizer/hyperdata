import { coreHealth } from "./core-health.ts";
import { AlertStore } from "./store.ts";
import { sendEmail } from "../supabase/functions/deliver-alerts/email.ts";
import { sendNtfy } from "../supabase/functions/deliver-alerts/ntfy.ts";
const path = "/srv/hyperdata/state/watchdog.json";
const store = new AlertStore();
let issue: string | null = null, active = true;
try {
  active = await store.active();
  if (active) {
    const state = await store.list();
    const stream = state.health.find((r) => r.worker_id === "stream"),
      fallback = state.health.find((r) => r.worker_id === "fallback");
    const fresh = (row: typeof stream, seconds = 45) =>
      row && Date.now() - Date.parse(row.heartbeat_at) < seconds * 1000;
    if (
      !fresh(stream) || !stream?.details.connected ||
      Date.now() - Date.parse(stream.details.last_market_at ?? "") > 45_000 ||
      Date.now() - Date.parse(stream.details.rules_refreshed_at ?? "") > 45_000
    ) {
      issue =
        "Live price stream is unavailable. The backup monitor may continue at 15-second intervals.";
    }
    if (!fresh(fallback)) {
      issue = (issue ?? "") + " The independent backup monitor is stale.";
    }
    if (
      Deno.env.get("LOCAL_CORE_ENABLED") === "true" &&
      !(await coreHealth()).healthy
    ) {
      issue = (issue ?? "") +
        " Local app data processors are stale or need reconciliation; check server health.";
    }
    const [backlog] = await store
      .sql`select count(*)::int as count from notification_outbox where (state in ('failed','ambiguous') and updated_at>now()-interval '24 hours') or (state not in ('sent','failed','ambiguous') and created_at<now()-interval '2 minutes')`;
    if (backlog.count) {
      issue = (issue ?? "") +
        " Price notification delivery needs attention; check email and iPhone status.";
    }
  }
} catch {
  issue =
    "Price alert database is unavailable. Notifications may be delayed until recovery.";
} finally {
  await store.close();
}
if (active) {
  let previous: { issue: string | null; at: number } = { issue: null, at: 0 };
  try {
    previous = JSON.parse(await Deno.readTextFile(path));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  if (
    issue ? Date.now() - previous.at > 15 * 60_000 : previous.issue !== null
  ) {
    const message = {
      subject: "HYPERDATA · alert runtime status",
      text: issue ??
        "Direct price alert monitoring and delivery have recovered.",
    };
    const user = Deno.env.get("ZOHO_SMTP_USER") ?? "";
    const outcomes = await Promise.allSettled([
      sendNtfy({
        baseUrl: Deno.env.get("NTFY_BASE_URL") ?? "",
        topic: Deno.env.get("NTFY_TOPIC") ?? "",
        clickUrl: (Deno.env.get("NOTIFICATION_ORIGIN") ??
          Deno.env.get("PUBLIC_ORIGIN") ?? "") + "/#/alerts",
      }, message),
      sendEmail({
        host: Deno.env.get("ZOHO_SMTP_HOST") ?? "smtp.zoho.com",
        port: 465,
        user,
        password: Deno.env.get("ZOHO_SMTP_PASSWORD") ?? "",
        from: `HYPERDATA <${user}>`,
        to: "jasonblick@zohomail.com",
      }, message),
    ]);
    if (outcomes.some((r) => r.status === "fulfilled")) {
      await Deno.writeTextFile(
        path,
        JSON.stringify({ issue, at: Date.now() }),
        { mode: 0o600 },
      );
    }
    if (outcomes.every((r) => r.status === "rejected")) {
      throw new Error("Watchdog providers unavailable");
    }
  } else if (!issue && previous.at !== 0) {
    await Deno.writeTextFile(path, JSON.stringify({ issue: null, at: 0 }), {
      mode: 0o600,
    });
  }
}
