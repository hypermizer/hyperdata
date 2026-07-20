import { decimal, decimalString } from "./decimal.ts";
import type { CrossRiskPosition, MarginTier } from "./types.ts";

function activeTier(notional: string, tiers: MarginTier[]): MarginTier {
  if (tiers.length === 0) throw new Error("margin table has no tiers");
  const sorted = [...tiers].sort((a, b) => decimal(a.lowerBound).comparedTo(b.lowerBound));
  let active = sorted[0];
  for (const tier of sorted) {
    if (decimal(notional).gte(tier.lowerBound)) active = tier;
  }
  return active;
}

export function initialMargin(
  notional: string,
  selectedLeverage: number,
  tiers: MarginTier[],
): string {
  if (!Number.isInteger(selectedLeverage) || selectedLeverage <= 0) {
    throw new Error("leverage must be a positive integer");
  }
  const tier = activeTier(notional, tiers);
  return decimalString(decimal(notional).div(Math.min(selectedLeverage, tier.maxLeverage)));
}

export function maintenanceMargin(notional: string, tiers: MarginTier[]): string {
  const tier = activeTier(notional, tiers);
  const maintenance = decimal(notional).times(tier.maintenanceRate).minus(tier.maintenanceDeduction);
  return decimalString(maintenance.isNegative() ? 0 : maintenance);
}

export function crossRisk(cashBalance: string, positions: CrossRiskPosition[]) {
  const equity = positions.reduce(
    (sum, position) => sum.plus(position.unrealizedPnl),
    decimal(cashBalance),
  );
  const maintenance = positions.reduce(
    (sum, position) => sum.plus(position.maintenanceMargin),
    decimal(0),
  );
  return {
    equity: decimalString(equity),
    maintenanceMargin: decimalString(maintenance),
    liquidatable: equity.lt(maintenance),
  };
}

export function isolatedRisk(
  isolatedMargin: string,
  unrealizedPnl: string,
  requiredMaintenance: string,
) {
  const equity = decimal(isolatedMargin).plus(unrealizedPnl);
  const maintenance = decimal(requiredMaintenance);
  return {
    equity: decimalString(equity),
    maintenanceMargin: decimalString(maintenance),
    liquidatable: equity.lt(maintenance),
  };
}
