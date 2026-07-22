import { RequestBudget } from "../_shared/paper/market-data.ts";

export const BASE_SNAPSHOT_WEIGHT = 22;
export const TRADE_REPLAY_WEIGHT = 20;

export interface ProcessorAssetWork {
  asset: string;
  hasPosition: boolean;
  requiresTradeReplay: boolean;
  accountIds: string[];
}

export function estimateSnapshotWeight(work: ProcessorAssetWork): number {
  return BASE_SNAPSHOT_WEIGHT + (work.requiresTradeReplay ? TRADE_REPLAY_WEIGHT : 0);
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
  estimateSnapshotWeight?(work: ProcessorAssetWork): number;
  fetchSnapshot(work: ProcessorAssetWork): Promise<ProcessorSnapshot>;
  processAccount(accountId: string, snapshot: ProcessorSnapshot): Promise<ProcessorAccountResult>;
  processStrategies?(accountId: string, snapshot: ProcessorSnapshot): Promise<{ evaluations: number; actions: number; degradedReason?: string }>;
  persistSnapshot?(snapshot: ProcessorSnapshot): Promise<void>;
}

export interface PaperProcessorResult {
  state: "succeeded" | "partial";
  assetsProcessed: number;
  accountsProcessed: number;
  apiWeight: number;
  reconciliationFailures: number;
  degradedAssets: Array<{ asset: string; reason: string }>;
  strategyEvaluations: number;
  strategyActions: number;
}

export function buildProcessorWork(
  positions: Array<{ epoch_id: string; asset: string }>,
  orders: Array<{ epoch_id: string; asset: string }>,
  recentFills: Array<{ epoch_id: string; asset: string }>,
  strategyAssignments: Array<{ epoch_id: string; asset: string }> = [],
): ProcessorAssetWork[] {
  const byAsset = new Map<string, { hasPosition: boolean; requiresTradeReplay: boolean; accountIds: Set<string> }>();
  for (const row of positions) {
    const entry = byAsset.get(row.asset) ?? { hasPosition: false, requiresTradeReplay: false, accountIds: new Set<string>() };
    entry.hasPosition = true; entry.accountIds.add(row.epoch_id); byAsset.set(row.asset, entry);
  }
  for (const row of orders) {
    const entry = byAsset.get(row.asset) ?? { hasPosition: false, requiresTradeReplay: false, accountIds: new Set<string>() };
    entry.requiresTradeReplay = true; entry.accountIds.add(row.epoch_id); byAsset.set(row.asset, entry);
  }
  for (const row of recentFills) {
    const entry = byAsset.get(row.asset) ?? { hasPosition: false, requiresTradeReplay: false, accountIds: new Set<string>() };
    entry.accountIds.add(row.epoch_id); byAsset.set(row.asset, entry);
  }
  for (const row of strategyAssignments) {
    const entry = byAsset.get(row.asset) ?? { hasPosition: false, requiresTradeReplay: false, accountIds: new Set<string>() };
    entry.accountIds.add(row.epoch_id); byAsset.set(row.asset, entry);
  }
  return [...byAsset].map(([asset, entry]) => ({
    asset,
    hasPosition: entry.hasPosition,
    requiresTradeReplay: entry.requiresTradeReplay,
    accountIds: [...entry.accountIds],
  }));
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
  let strategyEvaluations = 0;
  let strategyActions = 0;
  const degradedAssets: Array<{ asset: string; reason: string }> = [];

  for (const item of work) {
    const estimatedWeight = dependencies.estimateSnapshotWeight?.(item) ?? 0;
    if (!budget.tryConsume(estimatedWeight)) {
      degradedAssets.push({ asset: item.asset, reason: "api_budget_exhausted" });
      continue;
    }
    let snapshot: ProcessorSnapshot;
    try {
      snapshot = await dependencies.fetchSnapshot(item);
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
      if (dependencies.processStrategies) {
        try {
          const strategy = await dependencies.processStrategies(accountId, snapshot);
          strategyEvaluations += strategy.evaluations;
          strategyActions += strategy.actions;
          if (strategy.degradedReason) {
            degradedAssets.push({ asset: item.asset, reason: `strategy:${strategy.degradedReason}` });
          }
        } catch (error) {
          degradedAssets.push({ asset: item.asset, reason: `strategy:${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }
    await dependencies.persistSnapshot?.(snapshot);
    if (!acceptedByEveryAccount) degradedAssets.push({ asset: item.asset, reason: "account_snapshot_rejected" });
  }

  return {
    state: degradedAssets.length || reconciliationFailures ? "partial" : "succeeded",
    assetsProcessed,
    accountsProcessed,
    apiWeight: budget.used,
    reconciliationFailures,
    strategyEvaluations,
    strategyActions,
    degradedAssets,
  };
}
