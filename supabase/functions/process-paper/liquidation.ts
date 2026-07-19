import { applyFill } from "../_shared/paper/accounting.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
import { executeOrder } from "../_shared/paper/execution.ts";
import { liquidationDecision } from "../_shared/paper/liquidation.ts";
import type { NormalizedBook } from "../_shared/paper/market-data.ts";
import type { PaperPosition } from "../_shared/paper/types.ts";

interface LiquidationEffectInput {
  asset: string;
  position: PaperPosition;
  markPrice: string;
  equity: string;
  maintenanceMargin: string;
  book: NormalizedBook;
  feeRate: string;
  inputVersion: string;
  nowMs: number;
}

export interface LiquidationEffect {
  asset: string;
  classification: "partial" | "book" | "backstop";
  maintenanceMargin: string;
  remainingEquity: string;
  cooldownUntil: string | null;
  sourceTimestamp: string;
  inputVersion: string;
  fills: Array<{ price: string; size: string; fee: string; liquidity: "liquidation"; sourceId: string }>;
  position: PaperPosition | null;
  realizedPnl: string;
  totalFee: string;
  triggerSnapshot: Record<string, string>;
}

export function buildLiquidationEffect(input: LiquidationEffectInput): LiquidationEffect | null {
  const absoluteSize = decimal(input.position.signedSize).abs();
  const positionNotional = absoluteSize.times(input.markPrice);
  const decision = liquidationDecision({
    positionNotional: decimalString(positionNotional), absoluteSize: decimalString(absoluteSize),
    equity: input.equity, maintenanceMargin: input.maintenanceMargin, nowMs: input.nowMs,
  });
  if (decision.action === "none") return null;

  const side = decimal(input.position.signedSize).isPositive() ? "sell" : "buy";
  const execution = executeOrder({
    side, size: decision.liquidationSize, type: "market", timeInForce: null,
    limitPrice: null, reduceOnly: true,
  }, input.book, input.position.signedSize);
  const rawFills = execution.fills.map((fill) => ({ price: fill.price, size: fill.size }));
  if (decision.action === "backstop" && decimal(execution.remainingSize).isPositive()) {
    rawFills.push({ price: input.markPrice, size: execution.remainingSize });
  }
  if (rawFills.length === 0) return null;

  let position: PaperPosition | null = input.position;
  let realized = decimal(0);
  let totalFee = decimal(0);
  const fills = rawFills.map((fill, index) => {
    const transition = applyFill(position, { side, ...fill, feeRate: input.feeRate });
    position = transition.position;
    realized = realized.plus(transition.realizedPnl);
    totalFee = totalFee.plus(transition.fee);
    return {
      ...fill, fee: transition.fee, liquidity: "liquidation" as const,
      sourceId: `${input.inputVersion}:liquidation:${index}`,
    };
  });
  return {
    asset: input.asset, classification: decision.action,
    maintenanceMargin: input.maintenanceMargin,
    remainingEquity: decimalString(decimal(input.equity).plus(realized).minus(totalFee)),
    cooldownUntil: decision.cooldownUntilMs === null ? null : new Date(decision.cooldownUntilMs).toISOString(),
    sourceTimestamp: new Date(input.book.timestampMs).toISOString(), inputVersion: input.inputVersion,
    fills, position, realizedPnl: decimalString(realized), totalFee: decimalString(totalFee),
    triggerSnapshot: {
      equity: input.equity, maintenanceMargin: input.maintenanceMargin,
      markPrice: input.markPrice, positionNotional: decimalString(positionNotional),
      signedSize: input.position.signedSize,
    },
  };
}
