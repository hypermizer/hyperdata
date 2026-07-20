import { applyFill, unrealizedPnl } from "./accounting.ts";
import { decimal, decimalString } from "./decimal.ts";
import type { PaperPosition, Side } from "./types.ts";

interface HistoricalFill { side: Side; size: string; price: string; timestampMs: number }

export function reconstructPositionAt(fills: HistoricalFill[], boundaryMs: number): PaperPosition | null {
  let position: PaperPosition | null = null;
  for (const fill of [...fills].sort((a, b) => a.timestampMs - b.timestampMs)) {
    if (fill.timestampMs >= boundaryMs) break;
    position = applyFill(position, { ...fill, feeRate: "0" }).position;
  }
  return position;
}

interface ReconciliationInput {
  cashBalance: string;
  cachedEquity: string;
  positions: Array<PaperPosition & { markPrice: string; isolatedMargin: string | null }>;
}

export function reconcileAccount(input: ReconciliationInput) {
  const expected = input.positions.reduce((equity, position) => {
    // Isolated margin is reserved inside account equity; it is not new cash.
    return equity.plus(unrealizedPnl(position, position.markPrice));
  }, decimal(input.cashBalance));
  const difference = expected.minus(input.cachedEquity);
  return {
    expectedEquity: decimalString(expected),
    difference: decimalString(difference),
    reconciled: difference.abs().lte("0.000001"),
  };
}
