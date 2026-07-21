import { assertEquals } from "@std/assert";
import { calculateBacktestMetrics } from "../../_shared/strategies/metrics.ts";

Deno.test("metrics reconcile wins, losses, net PnL, and drawdown", () => {
  const metrics = calculateBacktestMetrics("5000", [
    { netPnl: "100", returnOnMargin: "0.2" },
    { netPnl: "-50", returnOnMargin: "-0.1" },
  ], ["5000", "5100", "5050"]);
  assertEquals(metrics.tradeCount, 2);
  assertEquals(metrics.winRate, "0.5");
  assertEquals(metrics.netPnl, "50");
  assertEquals(metrics.maxDrawdown, "0.0098039215686274509803921568627450980392156862745098");
});
