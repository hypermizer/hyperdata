import type { AlertRule, DetectorResult, MarketObservation } from "./types.ts";
export function evaluateFixedPrice(rule: AlertRule, current: MarketObservation): DetectorResult {
  const target = Number(rule.configuration.target); const direction = String(rule.configuration.direction);
  const qualifies = direction === "above" ? current.mark_price >= target : current.mark_price <= target;
  return { status: qualifies ? "triggered" : "not_triggered", qualifies, score: null, tailPercentile: null,
    classification: "fixed_price", modelVersion: null, referenceAgeSeconds: null,
    evidence: { direction, target, markPrice: current.mark_price } };
}
