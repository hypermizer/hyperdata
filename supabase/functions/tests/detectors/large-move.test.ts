import { assertEquals } from "@std/assert";
import { evaluateLargeMove } from "../../_shared/detectors/large-move.ts";
import type { AlertRule, DetectorModel, MarketObservation } from "../../_shared/types.ts";
const current = { asset: "BTC", dex: "", bucket: "2026-01-01T00:05:00Z", observed_at: "2026-01-01T00:05:01Z", mark_price: 110, oracle_price: 110,
  mid_price: 110, open_interest: 1, day_volume: 1 } satisfies MarketObservation;
const reference = { ...current, bucket: "2026-01-01T00:00:00Z", mark_price: 100, oracle_price: 100 };
const rule = { id: "r", user_id: "u", asset: "BTC", dex: "", detector: "large_move", detector_version: 1,
  configuration: { direction: "either", horizon_minutes: 5, tail_percentile: 0.9, minimum_move_percent: 0 }, delivery: "email", enabled: true, deleted_at: null } satisfies AlertRule;
const model = { asset: "BTC", horizon_minutes: 5, model_version: "v", source: "mark_history", parameters: { fastVariance: 0.00001, slowVariance: 0.00001,
  sessionFactor: 1, absoluteScores: Array.from({ length: 100 }, (_, i) => i / 100) }, sample_count: 100, expires_at: "2099-01-01T00:00:00Z" } satisfies DetectorModel;
Deno.test("qualifies empirically extreme moves", () => assertEquals(evaluateLargeMove(rule, { current, reference, model }).qualifies, true));
Deno.test("does not fabricate a score while warming", () => assertEquals(evaluateLargeMove(rule, { current, reference }).status, "warming"));
Deno.test("rejects stale references", () => assertEquals(evaluateLargeMove(rule, { current, reference: { ...reference, bucket: "2025-12-31T23:50:00Z" }, model }).status, "data_gap"));
Deno.test("uses only the pre-move online variance state when fresh", () => {
  const result = evaluateLargeMove(rule, { current, reference, model, volatilityState: { asset: "BTC", fast_variance: 0.01, slow_variance: 0.01, last_mark: 100, last_bucket: "2026-01-01T00:04:00Z" } });
  assertEquals(result.qualifies, false);
});
