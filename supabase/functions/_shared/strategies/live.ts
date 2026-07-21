import { decimal, decimalString } from "../paper/decimal.ts";
import type { MarginTier } from "../paper/types.ts";
import type { StrategyInterval } from "./types.ts";

const WIDTH: Record<StrategyInterval, number> = { "5m": 300_000, "1h": 3_600_000 };

export function completedCandleBucket(nowMs: number, interval: StrategyInterval): number {
  return Math.floor(nowMs / WIDTH[interval]) * WIDTH[interval];
}

function tierLeverage(notional: string, maximum: number, tiers: readonly MarginTier[]) {
  let leverage = maximum;
  for (const tier of [...tiers].sort((left, right) => decimal(left.lowerBound).comparedTo(right.lowerBound))) {
    if (decimal(notional).gte(tier.lowerBound)) leverage = Math.min(maximum, tier.maxLeverage);
  }
  return leverage;
}

export function entrySizing(
  availableMargin: string,
  allocationPct: string,
  price: string,
  sizeDecimals: number,
  maximumLeverage: number,
  tiers: readonly MarginTier[],
) {
  if (!Number.isInteger(sizeDecimals) || sizeDecimals < 0 || sizeDecimals > 12) throw new Error("invalid size precision");
  const margin = decimal(availableMargin).mul(allocationPct).div(100);
  let leverage = maximumLeverage;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    leverage = tierLeverage(decimalString(margin.mul(leverage)), maximumLeverage, tiers);
  }
  const notional = margin.mul(leverage);
  const scale = decimal(10).pow(sizeDecimals);
  const size = notional.div(price).mul(scale).floor().div(scale);
  if (!size.isPositive()) throw new Error("allocation rounds below minimum size");
  return {
    margin: decimalString(margin),
    leverage,
    notional: decimalString(notional),
    size: decimalString(size),
  };
}

export interface StrategyReturnInput {
  side: "long" | "short";
  size: string;
  entryPrice: string;
  entryInitialMargin: string;
  entryFees: string;
  fundingCashflows: string;
}

export function executableStrategyReturn(
  position: StrategyReturnInput,
  executableClosePrice: string,
  executableCloseSize: string,
  exitFeeRate: string,
): string {
  const closeSize = decimal(executableCloseSize);
  if (closeSize.lt(position.size)) throw new Error("insufficient executable close liquidity");
  const direction = position.side === "long" ? decimal(1) : decimal(-1);
  const gross = decimal(executableClosePrice).minus(position.entryPrice).mul(position.size).mul(direction);
  const exitFees = decimal(executableClosePrice).mul(position.size).mul(exitFeeRate).abs();
  return decimalString(gross.plus(position.fundingCashflows).minus(position.entryFees).minus(exitFees).div(position.entryInitialMargin));
}
