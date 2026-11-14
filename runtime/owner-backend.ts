import {
  localDataFetch,
  signLocalToken,
} from "../supabase/functions/_shared/local-data.ts";
import { servePaperCommand } from "../supabase/functions/paper-command/index.ts";
import { serveAssetNews } from "../supabase/functions/asset-news/index.ts";
import { serveAssetFundamentals } from "../supabase/functions/asset-fundamentals/index.ts";

const tables = new Set([
  "watchlist_items",
  "chart_grid_preferences",
  "comparison_preferences",
  "market_history_state",
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
  "asset_history_updates",
  "asset_mark_reference_snapshot",
  "mark_reference_health",
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
export function ownerBackend(config: {
  socket: string;
  secret: string;
  owner: string;
  email: string;
  origin: string;
}) {
  const dataFetch = localDataFetch(config.socket);
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
      const token = await signLocalToken(config.secret, {
        role: "authenticated",
        sub: config.owner,
        email: config.email,
      });
      const headers = new Headers({
        authorization: "Bearer " + token,
        origin: config.origin,
      });
      for (
        const name of [
          "accept",
          "content-type",
          "prefer",
          "range",
          "range-unit",
          "x-client-info",
        ]
      ) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const upstream = new Request(
        "http://local-data" + url.pathname + url.search,
        {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : await request.arrayBuffer(),
          signal: AbortSignal.timeout(25_000),
        },
      );
      let response: Response;
      if (url.pathname.startsWith("/functions/v1/")) {
        switch (url.pathname.split("/").at(-1)) {
          case "paper-command":
            response = await servePaperCommand(upstream);
            break;
          case "asset-news":
            response = await serveAssetNews(upstream);
            break;
          case "asset-fundamentals":
            response = await serveAssetFundamentals(upstream);
            break;
          default:
            return Response.json({ error: "Unavailable" }, { status: 404 });
        }
      } else response = await dataFetch(upstream);
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
        [204, 205, 304].includes(response.status) || request.method === "HEAD"
          ? null
          : body,
        { status: response.status, headers: output },
      );
    } catch (error) {
      console.error(
        "Local owner request failed:",
        error instanceof Error ? error.name : "Error",
      );
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
      onListen: () => console.log("Local owner backend listening"),
    },
    ownerBackend({
      socket: required("LOCAL_DATA_SOCKET"),
      secret: required("LOCAL_JWT_SECRET"),
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
