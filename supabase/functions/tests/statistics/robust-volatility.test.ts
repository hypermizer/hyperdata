import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { empiricalPercentile } from "../../_shared/statistics/empirical-tail.ts";
import { clippedResidual, forecastHorizonVariance, shrunkSessionFactor, updateVariance } from "../../_shared/statistics/robust-volatility.ts";
Deno.test("variance scales linearly and sigma scales by square root", () => {
  assertAlmostEquals(forecastHorizonVariance(0.0001, 0.0001, 4), 0.0004); assertAlmostEquals(Math.sqrt(0.0004), 2 * Math.sqrt(0.0001));
});
Deno.test("historical outliers are clipped", () => assert(updateVariance(0.0001, 10, 30) < 0.001));
Deno.test("candidate residual remains raw while update input is clipped", () => assertEquals(clippedResidual(10, 0.0001), 0.06));
Deno.test("sparse sessions shrink toward global", () => assertAlmostEquals(shrunkSessionFactor(4, 1, 0), 1));
Deno.test("empirical tails are monotonic and deterministic", () => assertEquals([empiricalPercentile(1, [1, 2, 3]), empiricalPercentile(3, [1, 2, 3])], [1 / 3, 1]));
