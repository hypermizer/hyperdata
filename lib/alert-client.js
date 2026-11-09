export function createAlertRuntimeClient(
  config,
  currentOrigin = globalThis.location?.origin,
  fetchImpl = globalThis.fetch,
) {
  const url = config.alertsRuntimeUrl ? new URL(config.alertsRuntimeUrl) : null;
  const sameOrigin = Boolean(url && url.origin === currentOrigin);
  let csrf = null, sessionPending = null;
  async function session() {
    if (!sameOrigin) {
      throw new Error("Open your private server to manage alerts.");
    }
    if (csrf) return;
    if (!sessionPending) {
      sessionPending = (async () => {
        const response = await fetchImpl("/api/alerts/session", {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Error("Could not authenticate the private alert runtime.");
        }
        const result = await response.json();
        csrf = result.csrf;
      })().finally(() => {
        sessionPending = null;
      });
    }
    await sessionPending;
  }
  async function request(path, method = "GET", body) {
    await session();
    const response = await fetchImpl(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: body
        ? { "content-type": "application/json", "x-csrf-token": csrf }
        : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 403) csrf = null;
      throw new Error(result.error ?? "Alert runtime unavailable.");
    }
    return result;
  }
  return {
    sameOrigin,
    url: url?.origin ?? null,
    session,
    list: () => request("/api/alerts"),
    liquidations: (asset, history=false) => request(`/api/liquidations?asset=${encodeURIComponent(asset)}${history?"&history=1":""}`),
    watchLiquidations: (asset, history=false) => request("/api/liquidations/watch","POST",{asset,history}),
    create: (input) => request("/api/alerts", "POST", input),
    change: (id, action) =>
      request(
        `/api/alerts/${encodeURIComponent(id)}`,
        action === "delete" ? "DELETE" : "PATCH",
        action === "delete" ? {} : { enabled: action === "enable" },
      ),
  };
}
