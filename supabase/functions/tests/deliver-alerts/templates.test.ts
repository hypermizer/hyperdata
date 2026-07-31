import { assertMatch } from "@std/assert";
import { buildNotification } from "../../deliver-alerts/templates.ts";
Deno.test("fixed alert template uses HYPERDATA identity", () => {
  const message = buildNotification({ asset: "xyz:ORCL", detector: "fixed_price", markPrice: 100.25, classification: "fixed_price",
    evidence: { direction: "above", target: 100, observedAt: "2026-07-31T17:13:02.571Z" }, bucket: "2026-07-31T17:13:00Z" });
  assertMatch(message.subject, /HYPERDATA · ORCL above \$100/);
  assertMatch(message.text, /mark \$100.25 crossed above target \$100/);
  assertMatch(message.text, /Observed 2026-07-31T17:13:02.571Z/);
});
Deno.test("move template includes empirical evidence", () => {
  const message = buildNotification({ asset: "OIL", detector: "large_move", markPrice: 80, classification: "underlying_move", evidence: { movePercent: 3, empiricalPercentile: 0.995 }, bucket: "now" });
  assertMatch(message.text, /99.50%/); assertMatch(message.text, /underlying move/);
});
