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
    const [paper, sources, history, references] = await Promise.all([
      get(
        "paper_processor_health?select=latest_finished_at,latest_state,reconciliation_failures_24h",
      ),
      get(
        "hyperliquid_account_sources?select=last_success_at,last_error&active=eq.true",
      ),
      get(
        "market_history_state?select=connected,last_frame_at,last_persisted_at,assets_sampled,assets_expected,repairs_pending,watched_repairs_pending,last_error",
      ),
      get("rpc/mark_reference_health"),
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
    const historyFresh = marketHistoryFresh(history[0]);
    const markReferencesFresh = referenceCoverageFresh(references);
    return {
      healthy: paperFresh && accountSyncFresh && historyFresh &&
        markReferencesFresh,
      markReferencesFresh,
      dotCoverage: references,
      historyFresh,
      referenceRepairsPending: history[0]?.repairs_pending ?? null,
      watchedReferenceRepairsPending: history[0]?.watched_repairs_pending ??
        null,
      paperFresh,
      accountSyncFresh,
      backend: "local",
    };
  } catch {
    return {
      healthy: false,
      markReferencesFresh: false,
      dotCoverage: null,
      historyFresh: false,
      referenceRepairsPending: null,
      watchedReferenceRepairsPending: null,
      paperFresh: false,
      accountSyncFresh: false,
      backend: "local",
    };
  }
}

export function marketHistoryFresh(
  row: {
    connected?: boolean;
    last_frame_at?: string;
    last_persisted_at?: string;
    assets_sampled?: number;
    assets_expected?: number;
  } | undefined,
  now = Date.now(),
) {
  return Boolean(
    row?.connected && row.last_frame_at && row.last_persisted_at &&
      now - Date.parse(row.last_frame_at) < 90000 &&
      now - Date.parse(row.last_persisted_at) < 120000 &&
      Number(row.assets_expected) > 0 &&
      Number(row.assets_sampled) >= Number(row.assets_expected),
  );
}

export function referenceCoverageFresh(
  coverage:
    | {
      assets?: number;
      total?: number;
      ready?: number;
      missing?: number;
      oldestCheck?: string;
    }
    | null
    | undefined,
  now = Date.now(),
) {
  return Boolean(
    coverage && Number(coverage.assets) > 0 &&
      Number(coverage.total) === Number(coverage.assets) * 7 &&
      coverage.ready === coverage.total && coverage.missing === 0 &&
      now - Date.parse(coverage.oldestCheck ?? "") < 60000,
  );
}
