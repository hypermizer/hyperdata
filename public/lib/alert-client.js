import {createOwnerSession,sharedOwnerSession} from './owner-session.js?v=20261109-owner';

export function createAlertRuntimeClient(
  config,
  currentOrigin = globalThis.location?.origin,
  fetchImpl = globalThis.fetch,
) {
  const local = config.runtimeOrigins?.includes(currentOrigin);
  const url = local ? new URL(currentOrigin) : config.alertsRuntimeUrl ? new URL(config.alertsRuntimeUrl) : null;
  const sameOrigin = Boolean(url && url.origin === currentOrigin);
  const identity=fetchImpl===globalThis.fetch?sharedOwnerSession():createOwnerSession(fetchImpl);
  async function session() {
    if (!sameOrigin) {
      throw new Error("Open your private server to manage alerts.");
    }
    return await identity.get();
  }
  async function request(path, method = "GET", body) {
    const {csrf}=await session();
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
      if (response.status === 403) identity.invalidate();
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
