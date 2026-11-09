import { allowedBrowserOrigin, browserCors } from "../_shared/browser-origins.ts";
import { createServiceClient } from "../_shared/database.ts";
import { sendEmail } from "../deliver-alerts/email.ts";
import { handleLoginLink, type LoginLinkDependencies } from "./handler.ts";

const OWNER_EMAIL = "jasonblick@zohomail.com";
const SITE_URL = "https://hypermizer.github.io/hyperdata/";


function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function dependencies(origin: string): LoginLinkDependencies {
  const service = createServiceClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  const smtpUser = required("ZOHO_SMTP_USER");
  return {
    allowedOrigin: origin,
    async claim() {
      const { data, error } = await service.rpc("claim_sign_in_email_delivery", {
        p_now: new Date().toISOString(),
      });
      if (error || !data) throw new Error(error?.message ?? "Unable to claim email delivery");
      return data;
    },
    async generate() {
      const { data, error } = await service.auth.admin.generateLink({
        type: "magiclink",
        email: OWNER_EMAIL,
        options: { redirectTo: origin === "https://hypermizer.github.io" ? SITE_URL : `${origin}/` },
      });
      const link = data?.properties?.action_link;
      if (error || !link) throw new Error(error?.message ?? "Unable to generate sign-in link");
      return link;
    },
    async send(link) {
      await sendEmail({
        host: Deno.env.get("ZOHO_SMTP_HOST") ?? "smtp.zoho.com",
        port: 465,
        user: smtpUser,
        password: required("ZOHO_SMTP_PASSWORD"),
        from: `HYPERDATA <${smtpUser}>`,
        to: OWNER_EMAIL,
      }, {
        subject: "HYPERDATA SIGN IN",
        text: `Open this link to sign in to HYPERDATA:\n\n${link}\n\nIf you did not request this, ignore this email.`,
      });
    },
  };
}

export async function serveLoginLink(request: Request): Promise<Response> {
  const origin = allowedBrowserOrigin(request);
  if (!origin) return Response.json({ error: "forbidden_origin" }, { status: 403 });
  const corsHeaders = browserCors(origin);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  let response: Response;
  try {
    response = await handleLoginLink(request, dependencies(origin));
  } catch {
    response = Response.json({ error: "delivery_failed" }, { status: 502 });
  }
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

if (import.meta.main) Deno.serve(serveLoginLink);
