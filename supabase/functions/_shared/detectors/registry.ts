import { validateRule } from "../rules.ts";
import type { AlertRule, DetectorResult } from "../types.ts";
import { evaluateFixedPrice } from "./fixed-price.ts";
import { evaluateLargeMove } from "./large-move.ts";
import type { DetectorContext } from "./types.ts";
export function evaluateRule(rule: AlertRule, context: DetectorContext): DetectorResult {
  validateRule(rule);
  return rule.detector === "fixed_price" ? evaluateFixedPrice(rule, context.current) : evaluateLargeMove(rule, context);
}
