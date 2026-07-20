import { assertEquals } from "@std/assert";
import { crossRisk, initialMargin, isolatedRisk, maintenanceMargin } from "../../_shared/paper/margin.ts";
import type { MarginTier } from "../../_shared/paper/types.ts";

const tiers: MarginTier[] = [
  { lowerBound: "0", maxLeverage: 20, maintenanceRate: "0.025", maintenanceDeduction: "0" },
  { lowerBound: "100000", maxLeverage: 10, maintenanceRate: "0.05", maintenanceDeduction: "2500" },
];

Deno.test("maintenance deductions keep tier boundaries continuous", () => {
  assertEquals(maintenanceMargin("99999.99", tiers), "2499.99975");
  assertEquals(maintenanceMargin("100000", tiers), "2500");
  assertEquals(maintenanceMargin("100000.01", tiers), "2500.0005");
});

Deno.test("initial margin respects selected leverage and tier maximum", () => {
  assertEquals(initialMargin("50000", 5, tiers), "10000");
  assertEquals(initialMargin("200000", 20, tiers), "20000");
});

Deno.test("cross risk aggregates pnl and maintenance across positions", () => {
  const safe = crossRisk("5000", [
    { unrealizedPnl: "1200", maintenanceMargin: "1000" },
    { unrealizedPnl: "-3000", maintenanceMargin: "1500" },
  ]);
  assertEquals(safe, { equity: "3200", maintenanceMargin: "2500", liquidatable: false });
  const unsafe = crossRisk("5000", [
    { unrealizedPnl: "-2600", maintenanceMargin: "2500" },
  ]);
  assertEquals(unsafe.liquidatable, true);
});

Deno.test("isolated risk cannot consume cross collateral", () => {
  assertEquals(isolatedRisk("500", "-450", "60"), {
    equity: "50",
    maintenanceMargin: "60",
    liquidatable: true,
  });
});
