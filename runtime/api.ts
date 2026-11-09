import { AlertStore } from "./store.ts";
import { validateRule } from "./validation.ts";
import { LiquidationStore } from "./liquidation-store.ts";
import { liquidationAsset } from "./liquidation-data.ts";
import { ownerBackendRequest } from "./unix-proxy.ts";

interface ApiStore {
  revoked(fingerprint: string): Promise<boolean>;
  active(): Promise<boolean>;
  list(): Promise<unknown>;
  create(
    input: ReturnType<typeof validateRule>,
    owner: string,
    fingerprint: string,
  ): Promise<unknown>;
  change(
    id: string,
    action: "enable" | "disable" | "delete",
    fingerprint: string,
  ): Promise<unknown>;
  health?(): Promise<unknown>;
}
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};
const json = (
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
) => Response.json(body, { status, headers: { ...headers, ...extra } });
function cookie(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map((v) => v.trim()).find(
    (v) => v.startsWith(`${name}=`),
  )?.slice(name.length + 1) ?? "";
}

export function alertApi(
  store: ApiStore,
  config: {
    origin: string;
    additionalOrigins?: string[];
    owner: string;
    ownerEmail?: string;
    ownerBackend?: (request: Request) => Promise<Response>;
    fingerprints?: string[];
    healthFingerprints?: string[];
    liquidations?: {
      read(asset: string, history: boolean): Promise<unknown>;
      watch(asset: string, history: boolean): Promise<boolean>;
    };
  },
) {
  const origin = new URL(config.origin).origin;
  const allowedOrigins = new Set([
    origin,
    ...(config.additionalOrigins ?? []).map((value) => new URL(value).origin),
  ]);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      fingerprint =
        request.headers.get("x-hyperdata-certificate")?.replaceAll(":", "")
          .toUpperCase() ?? "";
    if (
      request.headers.get("x-hyperdata-verified") !== "SUCCESS" ||
      !/^[A-F0-9]{40}$/.test(fingerprint) ||
      config.fingerprints?.length &&
        !config.fingerprints.includes(fingerprint) &&
        !config.healthFingerprints?.includes(fingerprint)
    ) return json({ error: "Client certificate required." }, 403);
    try {
      if (await store.revoked(fingerprint)) {
        return json({ error: "Client certificate revoked." }, 403);
      }
      if (
        request.headers.get("x-hyperdata-subject") ===
          "CN=Hyperdata Health Check" &&
        !config.healthFingerprints?.includes(fingerprint)
      ) return json({ error: "Health certificate is not enrolled." }, 403);
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(await store.health?.());
      }
      if (config.healthFingerprints?.includes(fingerprint)) {
        return json({ error: "Health-only certificate." }, 403);
      }
      if (request.method === "GET" && url.pathname === "/api/liquidations") {
        let asset;
        try {
          asset = liquidationAsset(url.searchParams.get("asset"));
        } catch {
          return json({ error: "Choose a supported perpetual asset." }, 400);
        }
        if (!config.liquidations) {
          return json({ error: "Liquidation data is not configured." }, 503);
        }
        return json(
          await config.liquidations.read(
            asset,
            url.searchParams.get("history") === "1",
          ),
        );
      }
      if (
        request.method === "GET" &&
        ["/api/alerts/session", "/api/owner/session"].includes(url.pathname)
      ) {
        const csrf = crypto.randomUUID() + crypto.randomUUID();
        return json(
          {
            csrf,
            backend: "server",
            owner: config.owner,
            user: { id: config.owner, email: config.ownerEmail },
          },
          200,
          {
            "set-cookie":
              `__Host-hyperdata-csrf=${csrf}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
          },
        );
      }
      if (request.method === "GET" && url.pathname === "/api/alerts") {
        return json(await store.list());
      }
      if (
        ["GET", "HEAD"].includes(request.method) &&
        url.pathname.startsWith("/api/owner/")
      ) {
        return config.ownerBackend
          ? await config.ownerBackend(request)
          : json({ error: "Owner data unavailable." }, 503);
      }
      if (!["POST", "PATCH", "DELETE"].includes(request.method)) {
        return json({ error: "Method not allowed." }, 405);
      }
      if (
        !allowedOrigins.has(request.headers.get("origin") ?? "") ||
        request.headers.get("sec-fetch-site") === "cross-site"
      ) return json({ error: "Forbidden origin." }, 403);
      const csrf = request.headers.get("x-csrf-token") ?? "";
      if (
        csrf.length !== 72 || csrf !== cookie(request, "__Host-hyperdata-csrf")
      ) {
        return json(
          { error: "Reload the page to renew your secure session." },
          403,
        );
      }
      if (!await store.active()) {
        return json({ error: "Alert runtime is in maintenance." }, 503);
      }
      if (
        !request.headers.get("content-type")?.startsWith("application/json")
      ) return json({ error: "JSON body required." }, 415);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 16_384) {
        return json({ error: "Request too large." }, 413);
      }
      if (
        url.pathname.startsWith("/api/owner/") && request.method === "DELETE" &&
        raw === ""
      ) {
        return config.ownerBackend
          ? await config.ownerBackend(new Request(request, { body: raw }))
          : json({ error: "Owner data unavailable." }, 503);
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "Invalid JSON." }, 400);
      }
      if (url.pathname.startsWith("/api/owner/")) {
        return config.ownerBackend
          ? await config.ownerBackend(new Request(request, { body: raw }))
          : json({ error: "Owner data unavailable." }, 503);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "Invalid request." }, 400);
      }
      if (
        request.method === "POST" && url.pathname === "/api/liquidations/watch"
      ) {
        let asset;
        try {
          asset = liquidationAsset(body.asset);
        } catch {
          return json({ error: "Choose a supported perpetual asset." }, 400);
        }
        if (!config.liquidations) {
          return json({ error: "Liquidation data is not configured." }, 503);
        }
        if (body.history !== undefined && typeof body.history !== "boolean") {
          return json({ error: "Invalid history option." }, 400);
        }
        const accepted = await config.liquidations.watch(
          asset,
          body.history === true,
        );
        return json(
          accepted ? { asset, accepted: true } : {
            error:
              "Close another liquidation chart before opening more markets.",
          },
          accepted ? 202 : 429,
        );
      }
      if (request.method === "POST" && url.pathname === "/api/alerts") {
        let normalized;
        try {
          normalized = validateRule(body);
        } catch (e) {
          return json({
            error: e instanceof Error ? e.message : "Invalid rule.",
          }, 400);
        }
        return json(
          await store.create(normalized, config.owner, fingerprint),
          201,
        );
      }
      const match = url.pathname.match(/^\/api\/alerts\/([a-f0-9-]{36})$/i);
      if (
        match && request.method === "PATCH" && typeof body.enabled === "boolean"
      ) {
        return json(
          await store.change(
            match[1],
            body.enabled ? "enable" : "disable",
            fingerprint,
          ),
        );
      }
      if (match && request.method === "DELETE") {
        return json(await store.change(match[1], "delete", fingerprint));
      }
      return json({ error: "Not found." }, 404);
    } catch {
      return json({ error: "Runtime temporarily unavailable." }, 503);
    }
  };
}
if (import.meta.main) {
  const store = new AlertStore();
  const origin = Deno.env.get("PUBLIC_ORIGIN"),
    owner = Deno.env.get("OWNER_ID");
  if (!origin || !owner) throw new Error("PUBLIC_ORIGIN and OWNER_ID required");
  const path = Deno.env.get("API_SOCKET") ?? "/run/hyperdata-api/api.sock";
  try {
    await Deno.remove(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const server = Deno.serve(
    {
      path,
      onListen: () => console.log("Hyperdata private API listening"),
    },
    alertApi(store, {
      origin,
      owner,
      ownerEmail: Deno.env.get("OWNER_EMAIL"),
      ownerBackend: ownerBackendRequest,
      additionalOrigins: Deno.env.get("ADDITIONAL_ORIGINS")?.split(",").filter(
        Boolean,
      ),
      liquidations: new LiquidationStore(store.sql),
      fingerprints: Deno.env.get("CLIENT_FINGERPRINTS")?.split(",").filter(
        Boolean,
      ),
      healthFingerprints: Deno.env.get("HEALTH_FINGERPRINTS")?.split(",")
        .filter(Boolean),
    }),
  );
  await Deno.chmod(path, 0o660);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => {
      void server.shutdown().then(() => store.close());
    });
  }
}
