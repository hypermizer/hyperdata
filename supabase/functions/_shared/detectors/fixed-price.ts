import type { AlertRule, DetectorResult, MarketObservation } from "./types.ts";
export function evaluateFixedPrice(rule: AlertRule, current: MarketObservation): DetectorResult {
  const target = Number(rule.configuration.target); const direction = String(rule.configuration.direction);
  if (!Number.isFinite(current.mark_price) || current.mark_price <= 0 || current.asset !== rule.asset || !Number.isFinite(target) || target <= 0 || !["above", "below"].includes(direction)) {
    return { status: "data_gap", qualifies: false, score: null, tailPercentile: null, classification: "fixed_price",
      modelVersion: null, referenceAgeSeconds: null, evidence: { reason: "Invalid or mismatched mark price" } };
  }
  const qualifies = direction === "above" ? current.mark_price >= target : current.mark_price <= target;
  return { status: qualifies ? "triggered" : "not_triggered", qualifies, score: null, tailPercentile: null,
    classification: "fixed_price", modelVersion: null, referenceAgeSeconds: null,
    evidence: { direction, target, markPrice: current.mark_price, observedAt: current.observed_at } };
}
