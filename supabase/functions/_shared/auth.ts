export function authorizeInternal(request: Request, expectedSecret: string): Response | null {
  const supplied = request.headers.get("x-monitor-secret");
  return supplied && supplied === expectedSecret ? null : Response.json({ error: "unauthorized" }, { status: 401 });
}
