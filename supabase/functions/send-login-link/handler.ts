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

  let claim: LoginLinkClaim;
  try { claim = await dependencies.claim(); }
  catch { return deliveryFailure("claim"); }
  if (claim === "cooldown") {
    return Response.json({ error: "please_wait", retryAfter: 10 }, { status: 429 });
  }
  if (claim === "hourly_limit") {
    return Response.json({ error: "hourly_limit", retryAfter: 3600 }, { status: 429 });
  }
  if (claim !== "claimed") return deliveryFailure("claim");

  let link: string;
  try { link = await dependencies.generate(); }
  catch { return deliveryFailure("generate"); }
  try { await dependencies.send(link); }
  catch { return deliveryFailure("send"); }
  return Response.json({ status: "sent" });
}

function deliveryFailure(stage: "claim" | "generate" | "send") {
  return Response.json({ error: "delivery_failed" }, {
    status: 502,
    headers: { "x-hyperdata-failure-stage": stage },
  });
}
