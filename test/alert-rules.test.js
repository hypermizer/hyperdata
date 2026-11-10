import test from "node:test";
import assert from "node:assert/strict";
import { alertStatusLabel, displayRule, listenerHealth, normalizeAlertRuleInput } from "../public/lib/alert-rules.js";
test("normalizes fixed rules", () => assert.deepEqual(normalizeAlertRuleInput({ asset: "xyz:ORCL", detector: "fixed_price", direction: "above", target: "100", delivery: "ntfy" }),
  { asset: "xyz:ORCL", detector: "fixed_price", delivery: "ntfy", configuration: { direction: "above", target: 100 } }));
test("normalizes move rules", () => assert.equal(normalizeAlertRuleInput({ asset: "OIL", detector: "large_move", direction: "either", horizonMinutes: "5", tailPercentile: "0.995", minimumMovePercent: "0", delivery: "ntfy" }).configuration.horizon_minutes, 5));
test("rejects invalid horizons", () => assert.throws(() => normalizeAlertRuleInput({ asset: "OIL", detector: "large_move", direction: "either", horizonMinutes: "0", tailPercentile: "0.995", minimumMovePercent: "0", delivery: "ntfy" })));
test("strips xyz prefix in rule display", () => assert.match(displayRule({ asset: "xyz:ORCL", detector: "fixed_price", configuration: { direction: "above", target: 100 } }), /^ORCL/));
test("classifies stale monitor health", () => assert.equal(listenerHealth({ state: "succeeded", finished_at: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-01T00:04:00Z")), "MONITOR STALE"));
test("shows an in-flight monitor without calling it failed", () => assert.equal(listenerHealth({ state: "claimed", started_at: new Date().toISOString() }), "MONITOR RUNNING"));
test("alert status prioritizes the delivery outcome after a trigger", () => {
  assert.equal(alertStatusLabel({ enabled: false, evaluationStatus: "triggered", deliveryState: "queued", delivery: "email" }), "TRIGGERED · EMAIL QUEUED");
  assert.equal(alertStatusLabel({ enabled: false, evaluationStatus: "triggered", deliveryState: "sent", delivery: "sms" }), "TRIGGERED · TEXT SENT");
  assert.equal(alertStatusLabel({ enabled: true, evaluationStatus: "warming", delivery: "email" }), "CALIBRATING");
  assert.equal(alertStatusLabel({ enabled: true, evaluationStatus: "data_gap", delivery: "email" }), "WAITING FOR MARKET DATA");
  assert.equal(alertStatusLabel({ enabled: false, evaluationStatus: "not_triggered", delivery: "email" }), "OFF");
});

test("new alerts default to ntfy only", () => {
  assert.equal(normalizeAlertRuleInput({ asset: "BTC", direction: "above", target: 100 }).delivery, "ntfy");
});
test("separate channels expose partial delivery instead of hiding a failure", async () => {
  const { alertDeliverySummary, priceStreamHealth } = await import("../public/lib/alert-rules.js");
  const summary = alertDeliverySummary([{ channel: "email", state: "failed" }, { channel: "ntfy", state: "sent" }],
    { enabled: false, evaluationStatus: "triggered", delivery: "both" });
  assert.match(summary, /EMAIL FAILED/); assert.match(summary, /IPHONE SENT/);
  assert.match(priceStreamHealth(null), /OFFLINE/);
  const now = Date.now(), fresh = new Date(now).toISOString();
  assert.equal(priceStreamHealth({ heartbeat_at: fresh, last_market_at: fresh, rules_refreshed_at: fresh, connected: true, pending_occurrences: 0, stale_assets: [] }, now), "LIVE PRICE STREAM HEALTHY");
  assert.match(priceStreamHealth({ heartbeat_at: fresh, last_market_at: fresh, rules_refreshed_at: fresh, connected: false }, now), /DEGRADED/);
});
test("historical email-only alerts do not falsely show an iPhone notification as queued", async () => {
  const { alertDeliverySummary } = await import("../public/lib/alert-rules.js");
  const label = alertDeliverySummary([{ channel: "email", state: "sent" }], { enabled: false, evaluationStatus: "triggered", delivery: "both" });
  assert.match(label, /IPHONE NOT RECORDED/); assert.doesNotMatch(label, /QUEUED/);
});
