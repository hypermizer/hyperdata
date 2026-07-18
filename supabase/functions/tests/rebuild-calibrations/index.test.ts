import { assert, assertEquals } from "@std/assert";
import { buildBootstrapModel } from "../../rebuild-calibrations/bootstrap.ts";
Deno.test("bootstrap is deterministic and preserves source sample history", () => {
  const candles = Array.from({ length: 260 }, (_, i) => ({ T: i * 60_000, c: 100 * Math.exp(i * 0.0001 + Math.sin(i) * 0.0002) }));
  const first = buildBootstrapModel(candles, 5); const second = buildBootstrapModel(candles, 5);
  assertEquals(first, second); assert(first.sampleCount >= 100); assert(first.parameters.absoluteScores.every(Number.isFinite));
  assert(Object.keys(first.parameters.sessionFactors ?? {}).length > 0);
  assertEquals(Object.keys(first.parameters.absoluteScoresByRegime ?? {}).sort(), ["high", "low", "middle"]);
});
Deno.test("hourly candles support a one-week horizon", () => {
  const candles = Array.from({ length: 800 }, (_, i) => ({ T: i * 3_600_000, c: 100 * Math.exp(i * 0.0002 + Math.sin(i) * 0.001) }));
  const model = buildBootstrapModel(candles, 10080, 60);
  assert(model.sampleCount >= 100);
});
Deno.test("model versions distinguish candle bootstrap from mark history", () => {
  const candles = Array.from({ length: 260 }, (_, i) => ({ T: i * 60_000, c: 100 * Math.exp(i * 0.0001 + Math.sin(i) * 0.0002) }));
  const candlesModel = buildBootstrapModel(candles, 5, 1, "bootstrap");
  const marksModel = buildBootstrapModel(candles, 5, 1, "marks");
  assert(candlesModel.modelVersion !== marksModel.modelVersion);
});
