import { assertEquals, assertThrows } from "@std/assert";
import { validateRule } from "../../_shared/rules.ts";
import type { AlertRule } from "../../_shared/types.ts";
const base: AlertRule = { id: "1", user_id: "u", asset: "xyz:ORCL", dex: "xyz", detector: "fixed_price", detector_version: 1,
  configuration: { direction: "above", target: 100 }, delivery: "email", enabled: true, deleted_at: null };
Deno.test("validates supported rule contracts", () => assertEquals(validateRule(base), base));
Deno.test("rejects unknown detector versions", () => { assertThrows(() => validateRule({ ...base, detector_version: 2 })); });
Deno.test("rejects malformed move rules", () => { assertThrows(() => validateRule({ ...base, detector: "large_move", configuration: { direction: "either", horizon_minutes: 0, tail_percentile: 0.995, minimum_move_percent: 0 } })); });
