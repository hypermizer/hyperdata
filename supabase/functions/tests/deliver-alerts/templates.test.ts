import { assertMatch } from "@std/assert";
import { buildNotification } from "../../deliver-alerts/templates.ts";
Deno.test("fixed alert template uses HYPERDATA identity", () => {
  const message = buildNotification({ asset: "xyz:ORCL", detector: "fixed_price", markPrice: 100, classification: "fixed_price", evidence: {}, bucket: "now" });
  assertMatch(message.subject, /HYPERDATA/); assertMatch(message.text, /ORCL/);
});
Deno.test("move template includes empirical evidence", () => {
  const message = buildNotification({ asset: "OIL", detector: "large_move", markPrice: 80, classification: "underlying_move", evidence: { movePercent: 3, empiricalPercentile: 0.995 }, bucket: "now" });
  assertMatch(message.text, /99.50%/); assertMatch(message.text, /underlying move/);
});
