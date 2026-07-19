import { fundingCashFlow } from "../_shared/paper/accounting.ts";
import type { FundingRatePoint } from "../_shared/paper/market-data.ts";
import { reconstructPositionAt } from "../_shared/paper/reconciliation.ts";
import type { Side } from "../_shared/paper/types.ts";

interface HistoricalFill { side: Side; size: string; price: string; timestampMs: number }

export interface FundingEffect {
  fundingTimestamp: string;
  signedSize: string;
  oraclePrice: string;
  fundingRate: string;
  payment: string;
  inputVersion: string;
}

export function missingFundingEffects(
  points: FundingRatePoint[],
  fills: HistoricalFill[],
  appliedTimestamps: Set<number>,
  oraclePrice: string,
  inputVersion: string,
): FundingEffect[] {
  return points
    .filter((point) => !appliedTimestamps.has(point.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .flatMap((point) => {
      const boundaryPosition = reconstructPositionAt(fills, point.timestampMs);
      if (!boundaryPosition) return [];
      return [{
        fundingTimestamp: new Date(point.timestampMs).toISOString(),
        signedSize: boundaryPosition.signedSize,
        oraclePrice,
        fundingRate: point.fundingRate,
        payment: fundingCashFlow(boundaryPosition.signedSize, oraclePrice, point.fundingRate),
        inputVersion,
      }];
    });
}
