import { RequestBudget } from "../_shared/paper/market-data.ts";

export interface ProcessorAssetWork {
  asset: string;
  hasPosition: boolean;
  accountIds: string[];
}

export interface ProcessorSnapshot {
  asset: string;
  inputVersion: string;
  apiWeight: number;
  degraded: boolean;
  payload: unknown;
}

export interface ProcessorAccountResult {
  mutated: boolean;
  reconciliationFailure?: boolean;
}

export interface PaperProcessorDependencies {
  loadWork(): Promise<ProcessorAssetWork[]>;
  fetchSnapshot(asset: string): Promise<ProcessorSnapshot>;
  processAccount(accountId: string, snapshot: ProcessorSnapshot): Promise<ProcessorAccountResult>;
}

export interface PaperProcessorResult {
  state: "succeeded" | "partial";
  assetsProcessed: number;
  accountsProcessed: number;
  apiWeight: number;
  reconciliationFailures: number;
  degradedAssets: Array<{ asset: string; reason: string }>;
}

/**
 * Coordinates a single claimed processor bucket. Economic calculations and
 * persistence stay behind processAccount so this function remains replayable
 * with captured public inputs.
 */
export async function processPaperBatch(
  dependencies: PaperProcessorDependencies,
  apiWeightLimit: number,
): Promise<PaperProcessorResult> {
  const budget = new RequestBudget(apiWeightLimit);
  const work = (await dependencies.loadWork()).sort((left, right) =>
    Number(right.hasPosition) - Number(left.hasPosition) || left.asset.localeCompare(right.asset)
  );
  let assetsProcessed = 0;
  let accountsProcessed = 0;
  let reconciliationFailures = 0;
  const degradedAssets: Array<{ asset: string; reason: string }> = [];

  for (const item of work) {
    let snapshot: ProcessorSnapshot;
    try {
      snapshot = await dependencies.fetchSnapshot(item.asset);
    } catch (error) {
      degradedAssets.push({
        asset: item.asset,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!budget.tryConsume(snapshot.apiWeight)) {
      degradedAssets.push({ asset: item.asset, reason: "api_budget_exhausted" });
      continue;
    }
    assetsProcessed += 1;
    if (snapshot.degraded) degradedAssets.push({ asset: item.asset, reason: "market_input_degraded" });
    for (const accountId of [...new Set(item.accountIds)].sort()) {
      const result = await dependencies.processAccount(accountId, snapshot);
      accountsProcessed += 1;
      if (result.reconciliationFailure) reconciliationFailures += 1;
    }
  }

  return {
    state: degradedAssets.length || reconciliationFailures ? "partial" : "succeeded",
    assetsProcessed,
    accountsProcessed,
    apiWeight: budget.used,
    reconciliationFailures,
    degradedAssets,
  };
}
