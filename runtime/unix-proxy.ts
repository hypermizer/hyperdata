import { request as httpRequest } from "node:http";
export async function ownerBackendRequest(request: Request) {
  const path = Deno.env.get("OWNER_BACKEND_SOCKET") ??
    "/run/hyperdata-owner/backend.sock";
  const url = new URL(request.url);
  const body = ["GET", "HEAD"].includes(request.method)
    ? null
    : new Uint8Array(await request.arrayBuffer());
  const allowed = [
    "accept",
    "content-type",
    "prefer",
    "range",
    "range-unit",
    "x-client-info",
  ];
  const headers = Object.fromEntries(
    allowed.flatMap((key) =>
      request.headers.has(key) ? [[key, request.headers.get(key)!]] : []
    ),
  );
  return await new Promise<Response>((resolve, reject) => {
    const upstream = httpRequest({
      socketPath: path,
      path: url.pathname.replace(/^\/api\/owner/, "") + url.search,
      method: request.method,
      headers,
    }, (res) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16_000_000) {
          upstream.destroy();
          reject(new Error("Owner response too large"));
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const responseHeaders = new Headers({
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        for (
          const name of ["content-type", "content-range", "preference-applied"]
        ) {
          const value = res.headers[name];
          if (typeof value === "string") responseHeaders.set(name, value);
        }
        const status = res.statusCode ?? 502;
        resolve(
          new Response([204, 205, 304].includes(status) ? null : bytes, {
            status,
            headers: responseHeaders,
          }),
        );
      });
      res.on("error", reject);
    });
    upstream.setTimeout(
      25_000,
      () => upstream.destroy(new Error("Owner backend timeout")),
    );
    upstream.on("error", reject);
    upstream.end(body);
  });
}
