import { decimal, decimalString } from "../paper/decimal.ts";

export interface MetricTrade { netPnl: string; returnOnMargin: string }

export function calculateBacktestMetrics(
  initialCapital: string,
  trades: readonly MetricTrade[],
  equityPoints: readonly string[],
) {
  const wins = trades.filter((trade) => decimal(trade.netPnl).gt(0)).length;
  const netPnl = trades.reduce((sum, trade) => sum.plus(trade.netPnl), decimal(0));
  let peak = decimal(initialCapital);
  let maximumDrawdown = decimal(0);
  for (const value of equityPoints) {
    const equity = decimal(value);
    if (equity.gt(peak)) peak = equity;
    if (peak.gt(0)) {
      const drawdown = peak.minus(equity).div(peak);
      if (drawdown.gt(maximumDrawdown)) maximumDrawdown = drawdown;
    }
  }
  return {
    tradeCount: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? decimalString(decimal(wins).div(trades.length)) : "0",
    netPnl: decimalString(netPnl),
    endingCapital: decimalString(decimal(initialCapital).plus(netPnl)),
    maxDrawdown: decimalString(maximumDrawdown),
    averageReturnOnMargin: trades.length
      ? decimalString(trades.reduce((sum, trade) => sum.plus(trade.returnOnMargin), decimal(0)).div(trades.length))
      : "0",
  };
}
