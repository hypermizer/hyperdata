import { assertEquals } from "@std/assert";
import { liquidationDecision } from "../../_shared/paper/liquidation.ts";

Deno.test("large positions liquidate twenty percent then cool down", () => {
  const decision = liquidationDecision({
    positionNotional: "150000",
    absoluteSize: "30",
    equity: "4000",
    maintenanceMargin: "5000",
    nowMs: 1_000,
  });
  assertEquals(decision, {
    action: "partial",
    liquidationSize: "6",
    cooldownUntilMs: 31_000,
  });
});

Deno.test("liquidatable positions use full book liquidation during partial cooldown", () => {
  const decision = liquidationDecision({
    positionNotional: "150000",
    absoluteSize: "30",
    equity: "4000",
    maintenanceMargin: "5000",
    nowMs: 10_000,
    partialCooldownActive: true,
  });
  assertEquals(decision, {
    action: "book",
    liquidationSize: "30",
    cooldownUntilMs: null,
  });
});

Deno.test("two-thirds maintenance boundary selects backstop", () => {
  assertEquals(liquidationDecision({
    positionNotional: "50000",
    absoluteSize: "10",
    equity: "2999.99",
    maintenanceMargin: "4500",
    nowMs: 0,
  }).action, "backstop");
  assertEquals(liquidationDecision({
    positionNotional: "50000",
    absoluteSize: "10",
    equity: "3000",
    maintenanceMargin: "4500",
    nowMs: 0,
  }).action, "book");
});

Deno.test("healthy accounts produce no liquidation action", () => {
  assertEquals(liquidationDecision({
    positionNotional: "50000",
    absoluteSize: "10",
    equity: "5000",
    maintenanceMargin: "4500",
    nowMs: 0,
  }), { action: "none", liquidationSize: "0", cooldownUntilMs: null });
});
