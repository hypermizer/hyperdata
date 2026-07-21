import { assert, assertEquals } from "@std/assert";
import { buildSharedCapitalPortfolio, runDualRsiBacktest } from "../../_shared/strategies/backtest.ts";
import type { StrategyCandle } from "../../_shared/strategies/types.ts";

function series(count: number, interval: "5m" | "1h", closes: (index: number) => number): StrategyCandle[] {
  const width = interval === "5m" ? 300_000 : 3_600_000;
  return Array.from({ length: count }, (_, index) => {
    const close = closes(index);
    return { asset: "BTC", interval, openTime: index * width, closeTime: (index + 1) * width, open: String(close), high: String(close * 1.001), low: String(close * .999), close: String(close), volume: "1", completed: true };
  });
}

Deno.test("backtest waits until the bar after a qualifying signal to enter", () => {
  const five = series(120, "5m", (i) => i < 115 ? 100 + (i % 2) : 140 + i);
  const hour = series(120, "1h", (i) => i < 115 ? 100 + (i % 2) : 140 + i);
  const result = runDualRsiBacktest({ asset: "BTC", fiveMinuteCandles: five, oneHourCandles: hour, initialCapital: "5000", marginAllocationPct: "10", maxLeverage: 20, takerFeeRate: "0.00035", slippageBps: "2", forcedEntry: { side: "short", signalIndex: 115 } });
  assertEquals(result.trades.length, 1);
  assert(result.trades[0].entryTime >= result.signals[0].candleCloseTime);
});

Deno.test("zero-signal input completes honestly with no fabricated trades", () => {
  const result = runDualRsiBacktest({ asset: "BTC", fiveMinuteCandles: series(120, "5m", () => 100), oneHourCandles: series(120, "1h", () => 100), initialCapital: "5000", marginAllocationPct: "10", maxLeverage: 20, takerFeeRate: "0.00035", slippageBps: "2" });
  assertEquals(result.trades, []);
  assertEquals(result.metrics.tradeCount, 0);
  assertEquals(result.fidelity.execution, "bar_conservative");
});

Deno.test("same-bar stop and take collision resolves adverse-first", () => {
  const five = series(120, "5m", () => 100);
  five[118] = { ...five[118], open: "100", high: "110", low: "90", close: "100" };
  const result = runDualRsiBacktest({ asset: "BTC", fiveMinuteCandles: five, oneHourCandles: series(120, "1h", () => 100), initialCapital: "5000", marginAllocationPct: "10", maxLeverage: 2, takerFeeRate: "0", slippageBps: "0", forcedEntry: { side: "long", signalIndex: 116 } });
  assertEquals(result.trades[0].exitReason, "stop");
  assertEquals(result.metrics.adverseFirstCount, 1);
});

Deno.test("fees can prevent a gross threshold touch from becoming a take", () => {
  const five = series(120, "5m", () => 100);
  five[118] = { ...five[118], open: "100", high: "101", low: "100", close: "100.5" };
  const result = runDualRsiBacktest({ asset: "BTC", fiveMinuteCandles: five, oneHourCandles: series(120, "1h", () => 100), initialCapital: "5000", marginAllocationPct: "10", maxLeverage: 20, takerFeeRate: "0.01", slippageBps: "0", forcedEntry: { side: "long", signalIndex: 116 } });
  assertEquals(result.trades.some((trade) => trade.exitReason === "take"), false);
});

Deno.test("portfolio shares capital across overlapping asset trades", () => {
  const trade = (asset: string, entryTime: number, exitTime: number, netPnl: string) => ({
    asset, side: "long" as const, entryTime, entryPrice: "100", exitTime, exitPrice: "110",
    initialMargin: "500", grossPnl: netPnl, fees: "0", funding: "0", netPnl,
    returnOnMargin: String(Number(netPnl) / 500), exitReason: "take" as const,
  });
  const result = buildSharedCapitalPortfolio("5000", "10", [
    trade("BTC", 1, 4, "100"), trade("ETH", 2, 3, "100"),
  ]);
  assertEquals(result.trades.map((item) => item.initialMargin), ["450", "500"]);
  assertEquals(result.metrics.netPnl, "190");
  assertEquals(result.metrics.endingCapital, "5190");
});

Deno.test("an intrabar stop precedes a later liquidation crossing", () => {
  const five = series(120, "5m", () => 100);
  five[118] = { ...five[118], open: "100", high: "100", low: "90", close: "95" };
  const result = runDualRsiBacktest({ asset: "BTC", fiveMinuteCandles: five, oneHourCandles: series(120, "1h", () => 100),
    initialCapital: "5000", marginAllocationPct: "10", maxLeverage: 20, takerFeeRate: "0", slippageBps: "0",
    forcedEntry: { side: "long", signalIndex: 116 } });
  assertEquals(result.trades[0].exitReason, "stop");
});

Deno.test("a gap beyond liquidation liquidates before a stop can execute", () => {
  const five = series(120, "5m", () => 100);
  five[118] = { ...five[118], open: "90", high: "95", low: "85", close: "90" };
  const result = runDualRsiBacktest({ asset: "BTC", fiveMinuteCandles: five, oneHourCandles: series(120, "1h", () => 100),
    initialCapital: "5000", marginAllocationPct: "10", maxLeverage: 20, takerFeeRate: "0", slippageBps: "0",
    forcedEntry: { side: "long", signalIndex: 116 } });
  assertEquals(result.trades[0].exitReason, "liquidation");
});
