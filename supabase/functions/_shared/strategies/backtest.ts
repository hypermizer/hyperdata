import { decimal, decimalString } from "../paper/decimal.ts";
import { maintenanceMargin } from "../paper/margin.ts";
import type { MarginTier } from "../paper/types.ts";
import { evaluateDualRsi, relativeRsiSeries } from "./dual-rsi.ts";
import { actualCoverage } from "./candles.ts";
import { calculateBacktestMetrics } from "./metrics.ts";
import { DEFAULT_DUAL_RSI_PARAMETERS, type StrategyCandle } from "./types.ts";

export interface BacktestInput {
  asset: string;
  fiveMinuteCandles: StrategyCandle[];
  oneHourCandles: StrategyCandle[];
  initialCapital: string;
  marginAllocationPct: string;
  maxLeverage: number;
  takerFeeRate: string;
  slippageBps: string;
  marginTiers?: MarginTier[];
  fundingByTimestamp?: Array<{ timestampMs: number; rate: string }>;
  forcedEntry?: { side: "long" | "short"; signalIndex: number };
  tradableStartMs?: number;
}

export interface BacktestTrade {
  asset: string;
  side: "long" | "short";
  entryTime: number;
  entryPrice: string;
  exitTime: number;
  exitPrice: string;
  initialMargin: string;
  grossPnl: string;
  fees: string;
  funding: string;
  netPnl: string;
  returnOnMargin: string;
  exitReason: "stop" | "take" | "liquidation" | "end_of_data";
}

interface OpenTrade {
  side: "long" | "short";
  entryTime: number;
  entryPrice: string;
  size: string;
  initialMargin: string;
  entryFee: string;
  funding: string;
}

function executionPrice(price: string, side: "buy" | "sell", slippageBps: string) {
  const adjustment = decimal(slippageBps).div(10_000);
  return decimalString(decimal(price).mul(side === "buy" ? decimal(1).plus(adjustment) : decimal(1).minus(adjustment)));
}

function closeEconomics(position: OpenTrade, rawPrice: string, feeRate: string, slippageBps: string) {
  const exitSide = position.side === "long" ? "sell" : "buy";
  const exitPrice = executionPrice(rawPrice, exitSide, slippageBps);
  const direction = position.side === "long" ? decimal(1) : decimal(-1);
  const gross = decimal(exitPrice).minus(position.entryPrice).mul(position.size).mul(direction);
  const exitFee = decimal(exitPrice).mul(position.size).mul(feeRate).abs();
  const fees = decimal(position.entryFee).plus(exitFee);
  const net = gross.plus(position.funding).minus(fees);
  return {
    exitPrice,
    grossPnl: decimalString(gross),
    exitFee: decimalString(exitFee),
    fees: decimalString(fees),
    netPnl: decimalString(net),
    returnOnMargin: decimalString(net.div(position.initialMargin)),
  };
}

function activeMaximumLeverage(notional: string, fallback: number, tiers?: MarginTier[]) {
  if (!tiers?.length) return fallback;
  let maximum = tiers[0].maxLeverage;
  for (const tier of [...tiers].sort((a, b) => decimal(a.lowerBound).comparedTo(b.lowerBound))) {
    if (decimal(notional).gte(tier.lowerBound)) maximum = tier.maxLeverage;
  }
  return Math.min(fallback, maximum);
}

export function runDualRsiBacktest(input: BacktestInput) {
  const trades: BacktestTrade[] = [];
  const signals: Array<{ decision: "enter_long" | "enter_short"; candleCloseTime: number }> = [];
  const equityPoints = [decimalString(input.initialCapital)];
  const equityTimeline: Array<{ sampledAt: number; equity: string; reason: "start" | "hourly" | "entry" | "exit" | "end" }> = input.fiveMinuteCandles.length
    ? [{ sampledAt: input.fiveMinuteCandles[0].openTime, equity: decimalString(input.initialCapital), reason: "start" }]
    : [];
  let cash = decimal(input.initialCapital);
  let position: OpenTrade | null = null;
  let pendingSide: "long" | "short" | null = null;
  let rearmReady = true;
  let adverseFirstCount = 0;
  const fiveMinutePoints = relativeRsiSeries(input.fiveMinuteCandles, 14, 100);
  const oneHourPoints = relativeRsiSeries(input.oneHourCandles, 14, 100);
  let latestHourIndex = -1;

  const closePosition = (bar: StrategyCandle, rawPrice: string, reason: BacktestTrade["exitReason"]) => {
    const open = position!;
    const economics = closeEconomics(open, rawPrice, input.takerFeeRate, input.slippageBps);
    cash = cash.plus(economics.netPnl);
    trades.push({ asset: input.asset, side: open.side, entryTime: open.entryTime, entryPrice: open.entryPrice,
      exitTime: bar.closeTime, exitPrice: economics.exitPrice, initialMargin: open.initialMargin,
      grossPnl: economics.grossPnl, fees: economics.fees, funding: open.funding,
      netPnl: economics.netPnl, returnOnMargin: economics.returnOnMargin, exitReason: reason });
    equityPoints.push(decimalString(cash));
    equityTimeline.push({ sampledAt: bar.closeTime, equity: decimalString(cash), reason: "exit" });
    position = null;
    rearmReady = false;
  };

  for (let index = 0; index < input.fiveMinuteCandles.length; index += 1) {
    const bar = input.fiveMinuteCandles[index];
    while (latestHourIndex + 1 < input.oneHourCandles.length && input.oneHourCandles[latestHourIndex + 1].closeTime <= bar.closeTime) latestHourIndex += 1;
    if (pendingSide && !position) {
      const margin = cash.mul(input.marginAllocationPct).div(100);
      let leverage = input.maxLeverage;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        leverage = activeMaximumLeverage(decimalString(margin.mul(leverage)), input.maxLeverage, input.marginTiers);
      }
      const entrySide = pendingSide === "long" ? "buy" : "sell";
      const entryPrice = executionPrice(bar.open, entrySide, input.slippageBps);
      const notional = margin.mul(leverage);
      const size = notional.div(entryPrice);
      position = { side: pendingSide, entryTime: bar.openTime, entryPrice, size: decimalString(size),
        initialMargin: decimalString(margin), entryFee: decimalString(notional.mul(input.takerFeeRate).abs()), funding: "0" };
      equityPoints.push(decimalString(cash));
      equityTimeline.push({ sampledAt: bar.openTime, equity: decimalString(cash.minus(position.entryFee)), reason: "entry" });
      pendingSide = null;
    }

    if (position) {
      for (const funding of input.fundingByTimestamp ?? []) {
        if (funding.timestampMs >= bar.openTime && funding.timestampMs < bar.closeTime) {
          const direction = position.side === "long" ? decimal(-1) : decimal(1);
          position.funding = decimalString(decimal(position.funding).plus(decimal(position.entryPrice).mul(position.size).mul(funding.rate).mul(direction)));
        }
      }
      const adversePrice = position.side === "long" ? bar.low : bar.high;
      const favorablePrice = position.side === "long" ? bar.high : bar.low;
      const adverse = closeEconomics(position, adversePrice, input.takerFeeRate, input.slippageBps);
      const favorable = closeEconomics(position, favorablePrice, input.takerFeeRate, input.slippageBps);
      const notionalAtAdverse = decimal(adverse.exitPrice).mul(position.size);
      const tiers = input.marginTiers ?? [{ lowerBound: "0", maxLeverage: input.maxLeverage, maintenanceRate: decimalString(decimal(1).div(input.maxLeverage * 2)), maintenanceDeduction: "0" }];
      const maintenance = decimal(maintenanceMargin(decimalString(notionalAtAdverse), tiers));
      const liquidation = decimal(position.initialMargin).plus(adverse.grossPnl).plus(position.funding).minus(adverse.fees).lte(maintenance);
      const stop = decimal(adverse.returnOnMargin).lte(DEFAULT_DUAL_RSI_PARAMETERS.stopReturn);
      const take = decimal(favorable.returnOnMargin).gte(DEFAULT_DUAL_RSI_PARAMETERS.takeReturn);
      if (stop && take) adverseFirstCount += 1;
      if (liquidation) closePosition(bar, adversePrice, "liquidation");
      else if (stop) closePosition(bar, adversePrice, "stop");
      else if (take) closePosition(bar, favorablePrice, "take");
    }

    if (!position && !pendingSide && index < input.fiveMinuteCandles.length - 1 && bar.closeTime >= (input.tradableStartMs ?? -Infinity)) {
      if (input.forcedEntry?.signalIndex === index) {
        pendingSide = input.forcedEntry.side;
        signals.push({ decision: pendingSide === "long" ? "enter_long" : "enter_short", candleCloseTime: bar.closeTime });
      } else if (index >= 114) {
        const fivePoint = fiveMinutePoints[index];
        const hourPoint = latestHourIndex >= 0 ? oneHourPoints[latestHourIndex] : null;
        if (fivePoint && hourPoint) {
          const evaluation = evaluateDualRsi(fivePoint, hourPoint, rearmReady);
          if (!rearmReady && evaluation.fiveMinute && evaluation.oneHour) {
            const short = decimal(evaluation.fiveMinute.ratio).gte("1.9") && decimal(evaluation.oneHour.ratio).gte("1.9");
            const long = decimal(evaluation.fiveMinute.ratio).lte("0.1") && decimal(evaluation.oneHour.ratio).lte("0.1");
            if (!short && !long) rearmReady = true;
          }
          if (evaluation.decision === "enter_long" || evaluation.decision === "enter_short") {
            pendingSide = evaluation.decision === "enter_long" ? "long" : "short";
            signals.push({ decision: evaluation.decision, candleCloseTime: bar.closeTime });
          }
        }
      }
    }
    if (bar.closeTime % 3_600_000 === 0) {
      const equity = position
        ? cash.plus(closeEconomics(position, bar.close, input.takerFeeRate, input.slippageBps).netPnl)
        : cash;
      equityTimeline.push({ sampledAt: bar.closeTime, equity: decimalString(equity), reason: "hourly" });
      equityPoints.push(decimalString(equity));
    }
  }

  if (position) closePosition(input.fiveMinuteCandles.at(-1)!, input.fiveMinuteCandles.at(-1)!.close, "end_of_data");
  if (input.fiveMinuteCandles.length) equityTimeline.push({ sampledAt: input.fiveMinuteCandles.at(-1)!.closeTime, equity: decimalString(cash), reason: "end" });
  const metrics = { ...calculateBacktestMetrics(input.initialCapital, trades, equityPoints), adverseFirstCount };
  return {
    asset: input.asset,
    coverage: { fiveMinute: actualCoverage(input.fiveMinuteCandles), oneHour: actualCoverage(input.oneHourCandles) },
    signals,
    trades,
    equityPoints,
    equityTimeline,
    metrics,
    fidelity: { signal: "exact", execution: "bar_conservative", constraints: input.marginTiers ? "supplied_constraints" : "current_constraints", funding: input.fundingByTimestamp ? "supplied" : "unavailable" },
  };
}
