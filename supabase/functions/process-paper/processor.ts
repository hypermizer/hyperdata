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
  accepted?: boolean;
}

export interface PaperProcessorDependencies {
  loadWork(): Promise<ProcessorAssetWork[]>;
  estimateSnapshotWeight?(asset: string): number;
  fetchSnapshot(asset: string): Promise<ProcessorSnapshot>;
  processAccount(accountId: string, snapshot: ProcessorSnapshot): Promise<ProcessorAccountResult>;
  persistSnapshot?(snapshot: ProcessorSnapshot): Promise<void>;
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
  rotationKey = 0,
): Promise<PaperProcessorResult> {
  const budget = new RequestBudget(apiWeightLimit);
  const loaded = await dependencies.loadWork();
  const rotate = (items: ProcessorAssetWork[]) => {
    const sorted = items.sort((left, right) => left.asset.localeCompare(right.asset));
    if (!sorted.length) return sorted;
    const offset = Math.abs(rotationKey) % sorted.length;
    return [...sorted.slice(offset), ...sorted.slice(0, offset)];
  };
  const work = [
    ...rotate(loaded.filter((item) => item.hasPosition)),
    ...rotate(loaded.filter((item) => !item.hasPosition)),
  ];
  let assetsProcessed = 0;
  let accountsProcessed = 0;
  let reconciliationFailures = 0;
  const degradedAssets: Array<{ asset: string; reason: string }> = [];

  for (const item of work) {
    const estimatedWeight = dependencies.estimateSnapshotWeight?.(item.asset) ?? 0;
    if (!budget.tryConsume(estimatedWeight)) {
      degradedAssets.push({ asset: item.asset, reason: "api_budget_exhausted" });
      continue;
    }
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
    if (snapshot.apiWeight > estimatedWeight && !budget.tryConsume(snapshot.apiWeight - estimatedWeight)) {
      degradedAssets.push({ asset: item.asset, reason: "api_budget_exhausted" });
      continue;
    }
    assetsProcessed += 1;
    if (snapshot.degraded) degradedAssets.push({ asset: item.asset, reason: "market_input_degraded" });
    let acceptedByEveryAccount = true;
    for (const accountId of [...new Set(item.accountIds)].sort()) {
      const result = await dependencies.processAccount(accountId, snapshot);
      accountsProcessed += 1;
      if (result.reconciliationFailure) reconciliationFailures += 1;
      if (result.accepted === false || result.reconciliationFailure) acceptedByEveryAccount = false;
    }
    if (acceptedByEveryAccount) await dependencies.persistSnapshot?.(snapshot);
    else degradedAssets.push({ asset: item.asset, reason: "account_snapshot_rejected" });
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
