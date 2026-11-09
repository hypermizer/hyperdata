import { request as httpRequest } from "node:http";

// PostgREST is reachable only through a permissioned Unix socket. Neither its
// JWTs nor its service role are ever returned to the browser.
export function localDataFetch(socket: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== "http://local-data" ||
      !url.pathname.startsWith("/rest/v1/")
    ) {
      throw new Error("Invalid local data destination");
    }
    const body = ["GET", "HEAD"].includes(request.method)
      ? null
      : new Uint8Array(await request.arrayBuffer());
    return await new Promise<Response>((resolve, reject) => {
      const upstream = httpRequest({
        socketPath: socket,
        path: url.pathname.slice(8) + url.search,
        method: request.method,
        headers: Object.fromEntries(request.headers),
      }, (res) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 32_000_000) {
            upstream.destroy(new Error("Local data response too large"));
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(name, value);
          }
          const status = res.statusCode ?? 502;
          resolve(
            new Response(
              [204, 205, 304].includes(status) || request.method === "HEAD"
                ? null
                : bytes,
              { status, headers },
            ),
          );
        });
        res.on("error", reject);
      });
      upstream.setTimeout(
        25_000,
        () => upstream.destroy(new Error("Local data timeout")),
      );
      const abort = () =>
        upstream.destroy(new Error("Local data request aborted"));
      request.signal.addEventListener("abort", abort, { once: true });
      upstream.on(
        "close",
        () => request.signal.removeEventListener("abort", abort),
      );
      upstream.on("error", reject);
      if (request.signal.aborted) abort();
      else upstream.end(body);
    });
  };
}
const encoder = new TextEncoder();
function encode(value: unknown) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
}
function bytes(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
async function key(secret: string) {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signLocalToken(
  secret: string,
  claims: Record<string, unknown>,
  now = Date.now(),
) {
  const value = encode({ alg: "HS256", typ: "JWT" }) + "." +
    encode({
      iss: "hyperdata-local",
      aud: "authenticated",
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 3600,
      ...claims,
    });
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(value)),
  );
  return value + "." +
    btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll(
      "/",
      "_",
    ).replaceAll("=", "");
}
export async function verifyLocalOwner(
  token: string,
  secret: string,
  owner: string,
  email: string,
  now = Date.now(),
) {
  try {
    const [header, payload, signature, extra] = token.split(".");
    if (
      extra || !signature ||
      JSON.parse(new TextDecoder().decode(bytes(header))).alg !== "HS256"
    ) return null;
    if (
      !await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        bytes(signature),
        encoder.encode(header + "." + payload),
      )
    ) return null;
    const claims = JSON.parse(new TextDecoder().decode(bytes(payload)));
    if (
      claims.iss !== "hyperdata-local" || claims.aud !== "authenticated" ||
      claims.role !== "authenticated" || claims.sub !== owner ||
      claims.email !== email || !Number.isFinite(claims.exp) ||
      claims.exp <= now / 1000 || claims.iat > now / 1000 + 30
    ) return null;
    return { id: owner, email };
  } catch {
    return null;
  }
}
export async function authenticateLocalOwner(token: string) {
  return await verifyLocalOwner(
    token,
    Deno.env.get("LOCAL_JWT_SECRET") ?? "",
    Deno.env.get("OWNER_ID") ?? "",
    Deno.env.get("OWNER_EMAIL") ?? "",
  );
}
