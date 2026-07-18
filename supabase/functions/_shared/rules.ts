import type { AlertRule, DeliveryChannel, DetectorName } from "./types.ts";
const DETECTORS = new Set<DetectorName>(["fixed_price", "large_move"]);
const DELIVERIES = new Set<DeliveryChannel>(["email", "sms"]);
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
export function validateRule(rule: AlertRule): AlertRule {
  if (!rule.id || !rule.asset || !DETECTORS.has(rule.detector)) throw new Error("Unknown or incomplete alert rule");
  if (rule.detector_version !== 1) throw new Error("Unsupported detector version");
  if (!DELIVERIES.has(rule.delivery)) throw new Error("Unsupported delivery channel");
  const config = rule.configuration;
  if (rule.detector === "fixed_price") {
    if (!["above", "below"].includes(String(config.direction)) || !finitePositive(config.target)) throw new Error("Invalid fixed-price configuration");
  } else {
    const horizon = config.horizon_minutes; const percentile = config.tail_percentile; const floor = config.minimum_move_percent;
    if (!["up", "down", "either"].includes(String(config.direction)) || !Number.isInteger(horizon) || Number(horizon) < 1 || Number(horizon) > 10080 || typeof percentile !== "number" || percentile < 0.9 || percentile > 0.9999 || typeof floor !== "number" || !Number.isFinite(floor) || floor < 0) throw new Error("Invalid large-move configuration");
  }
  return rule;
}
