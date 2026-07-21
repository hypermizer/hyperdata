import { assertEquals } from "@std/assert";
import { assignmentStateAfterEvaluation, assignmentStateAfterExit, completedCandleBucket, entrySizing, executableStrategyReturn } from "../../_shared/strategies/live.ts";

const tiers = [
  { lowerBound: "0", maxLeverage: 20, maintenanceRate: "0.025", maintenanceDeduction: "0" },
  { lowerBound: "10000", maxLeverage: 10, maintenanceRate: "0.05", maintenanceDeduction: "250" },
];

Deno.test("completed buckets never identify the in-progress candle", () => {
  assertEquals(completedCandleBucket(Date.parse("2026-07-21T12:07:00Z"), "5m"), Date.parse("2026-07-21T12:05:00Z"));
  assertEquals(completedCandleBucket(Date.parse("2026-07-21T12:07:00Z"), "1h"), Date.parse("2026-07-21T12:00:00Z"));
});

Deno.test("entry sizing iterates the notional tier and rounds down to asset precision", () => {
  assertEquals(entrySizing("5000", "20", "100", 4, 20, tiers), {
    margin: "1000", leverage: 10, notional: "10000", size: "100",
  });
});

Deno.test("executable return includes fees and funding for symmetric long and short positions", () => {
  assertEquals(executableStrategyReturn({ side: "long", size: "10", entryPrice: "100", entryInitialMargin: "50", entryFees: "1", fundingCashflows: "-0.5" }, "101", "10", "0.001"), "0.1498");
  assertEquals(executableStrategyReturn({ side: "short", size: "10", entryPrice: "100", entryInitialMargin: "50", entryFees: "1", fundingCashflows: "0.5" }, "99", "10", "0.001"), "0.1702");
});

Deno.test("rearm and exit-managed pause states cannot silently enable entries", () => {
  assertEquals(assignmentStateAfterEvaluation("ready", false, false), "await_rearm");
  assertEquals(assignmentStateAfterEvaluation("ready", false, true), "armed");
  assertEquals(assignmentStateAfterExit("exit_managed_paused", "take"), "paused");
  assertEquals(assignmentStateAfterExit("position_open", "take"), "await_rearm");
});
