import { createClient, type Session } from "@supabase/supabase-js";

const tables = new Set([
  "watchlist_items",
  "new_asset_acknowledgements",
  "asset_analytics_cache",
  "audio_listener_assets",
  "level_tool_preferences",
  "paper_accounts",
  "paper_account_epochs",
  "paper_account_summaries",
  "paper_positions",
  "paper_orders",
  "paper_leverage_settings",
  "paper_processor_health",
  "paper_order_history",
  "paper_ledger_history",
  "paper_ledger_entries",
  "paper_commands",
  "trade_log_orders",
  "hyperliquid_account_sources",
  "hyperliquid_account_position_tags",
  "hyperliquid_account_fills",
  "hyperliquid_account_positions",
]);
const rpcs = new Set([
  "paper_fee_volume",
  "create_paper_account",
  "reset_paper_account",
  "archive_paper_account",
  "cancel_paper_order",
]);
const functions = new Set([
  "paper-command",
  "asset-news",
  "asset-fundamentals",
]);
export function allowedOwnerPath(path: string) {
  const table = path.match(/^\/rest\/v1\/([a-z_]+)$/);
  const rpc = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
  const fn = path.match(/^\/functions\/v1\/([a-z-]+)$/);
  return Boolean(
    table && tables.has(table[1]) || rpc && rpcs.has(rpc[1]) ||
      fn && functions.has(fn[1]),
  );
}
export function ownerBackend(
  config: {
    url: string;
    key: string;
    owner: string;
    email: string;
    origin: string;
  },
) {
  const client = createClient(config.url, config.key, {
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  let current: Session | null = null, pending: Promise<Session> | null = null;
  async function session(): Promise<Session> {
    if (current && (current.expires_at ?? 0) * 1000 > Date.now() + 60_000) {
      return current;
    }
    if (!pending) {
      pending = (async () => {
        if (current?.refresh_token) {
          const refreshed = await client.auth.refreshSession({
            refresh_token: current.refresh_token,
          });
          if (refreshed.data.session?.user.id === config.owner) {
            current = refreshed.data.session;
            return current;
          }
        }
        // Administrative link generation does not send email. The one-time token
        // is consumed here; the resulting owner JWT never leaves this service.
        const generated = await client.auth.admin.generateLink({
          type: "magiclink",
          email: config.email,
        });
        if (
          generated.error || generated.data.user?.id !== config.owner ||
          !generated.data.properties?.hashed_token
        ) throw new Error("Owner access unavailable");
        const verified = await client.auth.verifyOtp({
          token_hash: generated.data.properties.hashed_token,
          type: "magiclink",
        });
        if (
          verified.error || verified.data.session?.user.id !== config.owner
        ) throw new Error("Owner access unavailable");
        current = verified.data.session;
        return current;
      })().finally(() => {
        pending = null;
      });
    }
    return await pending;
  }
  return async (request: Request) => {
    const url = new URL(request.url);
    if (
      !allowedOwnerPath(url.pathname) ||
      !["GET", "POST", "PATCH", "DELETE", "HEAD"].includes(request.method)
    ) {
      return Response.json({ error: "Owner endpoint unavailable." }, {
        status: 404,
      });
    }
    try {
      const identity = await session();
      const headers = new Headers({
        apikey: config.key,
        authorization: "Bearer " + identity.access_token,
        origin: config.origin,
      });
      for (
        const key of [
          "accept",
          "content-type",
          "prefer",
          "range",
          "range-unit",
          "x-client-info",
        ]
      ) {
        const value = request.headers.get(key);
        if (value) headers.set(key, value);
      }
      const response = await fetch(config.url + url.pathname + url.search, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : await request.arrayBuffer(),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
      if (response.status === 401) current = null;
      const body = await response.arrayBuffer();
      if (body.byteLength > 16_000_000) {
        throw new Error("Owner response too large");
      }
      const output = new Headers({ "cache-control": "no-store" });
      for (
        const key of ["content-type", "content-range", "preference-applied"]
      ) {
        const value = response.headers.get(key);
        if (value) output.set(key, value);
      }
      return new Response(
        [204, 205, 304].includes(response.status) ? null : body,
        { status: response.status, headers: output },
      );
    } catch {
      return Response.json(
        { error: "Owner data is temporarily unavailable." },
        { status: 503 },
      );
    }
  };
}
if (import.meta.main) {
  const required = (name: string) => {
    const value = Deno.env.get(name);
    if (!value) throw new Error("Missing owner backend configuration");
    return value;
  };
  const path = "/run/hyperdata-owner/backend.sock";
  try {
    await Deno.remove(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const server = Deno.serve(
    {
      path,
      onListen: () => console.log("Private owner backend listening"),
    },
    ownerBackend({
      url: required("SUPABASE_URL"),
      key: required("SUPABASE_SERVICE_ROLE_KEY"),
      owner: required("OWNER_ID"),
      email: required("OWNER_EMAIL"),
      origin: required("PUBLIC_ORIGIN"),
    }),
  );
  await Deno.chmod(path, 0o660);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => void server.shutdown());
  }
}
