import test from "node:test";
import assert from "node:assert/strict";
import { displayRule, listenerHealth, normalizeAlertRuleInput } from "../public/lib/alert-rules.js";
test("normalizes fixed rules", () => assert.deepEqual(normalizeAlertRuleInput({ asset: "xyz:ORCL", detector: "fixed_price", direction: "above", target: "100", delivery: "email" }),
  { asset: "xyz:ORCL", detector: "fixed_price", delivery: "email", configuration: { direction: "above", target: 100 } }));
test("normalizes move rules", () => assert.equal(normalizeAlertRuleInput({ asset: "OIL", detector: "large_move", direction: "either", horizonMinutes: "5", tailPercentile: "0.995", minimumMovePercent: "0", delivery: "sms" }).configuration.horizon_minutes, 5));
test("rejects invalid horizons", () => assert.throws(() => normalizeAlertRuleInput({ asset: "OIL", detector: "large_move", direction: "either", horizonMinutes: "0", tailPercentile: "0.995", minimumMovePercent: "0", delivery: "email" })));
test("strips xyz prefix in rule display", () => assert.match(displayRule({ asset: "xyz:ORCL", detector: "fixed_price", configuration: { direction: "above", target: 100 } }), /^ORCL/));
test("classifies stale monitor health", () => assert.equal(listenerHealth({ state: "succeeded", finished_at: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-01T00:04:00Z")), "MONITOR STALE"));
test("shows an in-flight monitor without calling it failed", () => assert.equal(listenerHealth({ state: "claimed", started_at: new Date().toISOString() }), "MONITOR RUNNING"));
