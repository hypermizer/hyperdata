import { fundingCashFlow } from "../_shared/paper/accounting.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
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
  oraclePrice: string | ((timestampMs: number) => string | null),
  inputVersion: string,
  persistedExposure?: Map<number, string>,
): FundingEffect[] {
  return points
    .filter((point) => !appliedTimestamps.has(point.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .flatMap((point) => {
      const replayedPosition = reconstructPositionAt(fills, point.timestampMs);
      const signedSize = decimal(persistedExposure?.get(point.timestampMs) ?? 0)
        .plus(replayedPosition?.signedSize ?? 0);
      const boundaryOracle = typeof oraclePrice === "function" ? oraclePrice(point.timestampMs) : oraclePrice;
      if (signedSize.isZero() || boundaryOracle === null) return [];
      return [{
        fundingTimestamp: new Date(point.timestampMs).toISOString(),
        signedSize: decimalString(signedSize),
        oraclePrice: boundaryOracle,
        fundingRate: point.fundingRate,
        payment: fundingCashFlow(decimalString(signedSize), boundaryOracle, point.fundingRate),
        inputVersion,
      }];
    });
}
