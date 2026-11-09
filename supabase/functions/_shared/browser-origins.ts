export function allowedBrowserOrigin(request: Request, runtimeOrigin = Deno.env.get("HYPERDATA_APP_ORIGIN")): string | null {
  const origin = request.headers.get("origin");
  return origin && runtimeOrigin && origin === runtimeOrigin ? origin : null;
}
export function browserCors(origin: string) {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS", "vary": "Origin" };
}
