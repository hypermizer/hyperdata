export type StrategyInterval = "5m" | "1h";

export interface StrategyCandle {
  asset: string;
  interval: StrategyInterval;
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  completed: boolean;
  sourceVersion?: string;
}

export interface RelativeRsiPoint {
  rsi: string;
  baseline: string;
  ratio: string;
  candleCloseTime: number;
  sourceVersion?: string;
}

export type DualRsiDecision = "warming" | "armed" | "enter_long" | "enter_short" | "hold";

export interface DualRsiEvaluation {
  status: "warming" | "armed";
  decision: DualRsiDecision;
  fiveMinute: RelativeRsiPoint | null;
  oneHour: RelativeRsiPoint | null;
  rearmReady: boolean;
}

export interface DualRsiParameters {
  rsiPeriod: number;
  baselineLength: number;
  shortRatio: string;
  longRatio: string;
  stopReturn: string;
  takeReturn: string;
  marginAllocationPct: string;
}

export const DEFAULT_DUAL_RSI_PARAMETERS: Readonly<DualRsiParameters> = Object.freeze({
  rsiPeriod: 14,
  baselineLength: 100,
  shortRatio: "1.9",
  longRatio: "0.1",
  stopReturn: "-0.1",
  takeReturn: "0.2",
  marginAllocationPct: "10",
});
