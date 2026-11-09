import { ownerBackendRequest } from "./unix-proxy.ts";
export async function coreHealth() {
  try {
    const get = async (path: string) => {
      const response = await ownerBackendRequest(
        new Request("http://local-api/api/owner/rest/v1/" + path),
      );
      if (!response.ok) throw new Error("Local core data unavailable");
      return await response.json();
    };
    const [paper, sources] = await Promise.all([
      get(
        "paper_processor_health?select=latest_finished_at,latest_state,reconciliation_failures_24h",
      ),
      get(
        "hyperliquid_account_sources?select=last_success_at,last_error&active=eq.true",
      ),
    ]);
    const paperFresh = Boolean(
      paper[0]?.latest_finished_at &&
        Date.now() - Date.parse(paper[0].latest_finished_at) < 120_000 &&
        !Number(paper[0].reconciliation_failures_24h),
    );
    const accountSyncFresh = sources.every((
      row: { last_success_at: string; last_error: string | null },
    ) =>
      !row.last_error && row.last_success_at &&
      Date.now() - Date.parse(row.last_success_at) < 240_000
    );
    return {
      healthy: paperFresh && accountSyncFresh,
      paperFresh,
      accountSyncFresh,
      backend: "local",
    };
  } catch {
    return {
      healthy: false,
      paperFresh: false,
      accountSyncFresh: false,
      backend: "local",
    };
  }
}
