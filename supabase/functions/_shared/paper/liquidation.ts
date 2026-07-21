import { decimal, decimalString } from "./decimal.ts";
import type { LiquidationDecision, LiquidationInput } from "./types.ts";

const LARGE_POSITION_NOTIONAL = "100000";
const PARTIAL_FRACTION = "0.2";
const COOLDOWN_MS = 30_000;

export function liquidationDecision(input: LiquidationInput): LiquidationDecision {
  const equity = decimal(input.equity);
  const maintenance = decimal(input.maintenanceMargin);
  if (equity.gte(maintenance)) {
    return { action: "none", liquidationSize: "0", cooldownUntilMs: null };
  }
  if (equity.lt(maintenance.times(2).div(3))) {
    return {
      action: "backstop",
      liquidationSize: decimalString(input.absoluteSize),
      cooldownUntilMs: null,
    };
  }
  if (input.partialCooldownActive) {
    return {
      action: "book",
      liquidationSize: decimalString(input.absoluteSize),
      cooldownUntilMs: null,
    };
  }
  if (decimal(input.positionNotional).gte(LARGE_POSITION_NOTIONAL)) {
    return {
      action: "partial",
      liquidationSize: decimalString(decimal(input.absoluteSize).times(PARTIAL_FRACTION)),
      cooldownUntilMs: input.nowMs + COOLDOWN_MS,
    };
  }
  return {
    action: "book",
    liquidationSize: decimalString(input.absoluteSize),
    cooldownUntilMs: null,
  };
}
