export type LoginLinkClaim = "claimed" | "cooldown" | "hourly_limit";

export interface LoginLinkDependencies {
  allowedOrigin: string;
  claim(): Promise<LoginLinkClaim>;
  generate(): Promise<string>;
  send(link: string): Promise<void>;
}

export async function handleLoginLink(
  request: Request,
  dependencies: LoginLinkDependencies,
): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (request.headers.get("origin") !== dependencies.allowedOrigin) {
    return Response.json({ error: "forbidden_origin" }, { status: 403 });
  }

  try {
    const claim = await dependencies.claim();
    if (claim === "cooldown") {
      return Response.json({ error: "please_wait", retryAfter: 10 }, { status: 429 });
    }
    if (claim === "hourly_limit") {
      return Response.json({ error: "hourly_limit", retryAfter: 3600 }, { status: 429 });
    }
    if (claim !== "claimed") throw new Error("Unexpected delivery claim");
    const link = await dependencies.generate();
    await dependencies.send(link);
    return Response.json({ status: "sent" });
  } catch {
    return Response.json({ error: "delivery_failed" }, { status: 502 });
  }
}
