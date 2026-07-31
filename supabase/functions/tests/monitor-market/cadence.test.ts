import { assertEquals } from "@std/assert";
import { assetIdsForBucket, isMinuteBucket, monitorBucket, rulesForBucket } from "../../monitor-market/cadence.ts";
import type { AlertRule } from "../../_shared/types.ts";

const fixed = { id: "fixed", asset: "xyz:FIXED", detector: "fixed_price" } as AlertRule;
const move = { id: "move", asset: "xyz:MOVE", detector: "large_move" } as AlertRule;

Deno.test("monitor buckets fixed-price checks every fifteen seconds", () => {
  assertEquals(monitorBucket(new Date("2026-07-31T17:13:29.999Z")).toISOString(), "2026-07-31T17:13:15.000Z");
  assertEquals(monitorBucket(new Date("2026-07-31T17:13:45.001Z")).toISOString(), "2026-07-31T17:13:45.000Z");
});

Deno.test("statistical rules and persisted observations remain minute-aligned", () => {
  const minute = new Date("2026-07-31T17:13:00.000Z");
  const quarter = new Date("2026-07-31T17:13:15.000Z");
  assertEquals(isMinuteBucket(minute), true);
  assertEquals(isMinuteBucket(quarter), false);
  assertEquals(rulesForBucket([fixed, move], minute).map(({ id }) => id), ["fixed", "move"]);
  assertEquals(rulesForBucket([fixed, move], quarter).map(({ id }) => id), ["fixed"]);
  assertEquals(assetIdsForBucket([fixed, move], [{ asset: "xyz:WATCHED" }], minute), [fixed.asset, move.asset, "xyz:WATCHED"]);
  assertEquals(assetIdsForBucket([fixed, move], [{ asset: "xyz:WATCHED" }], quarter), [fixed.asset]);
});
