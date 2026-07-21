export type MarginMode = "cross" | "isolated";
export type Side = "buy" | "sell";
export type Liquidity = "maker" | "taker";

export interface PaperPosition {
  signedSize: string;
  entryPrice: string;
}

export interface FillInput {
  side: Side;
  size: string;
  price: string;
  feeRate: string;
}

export interface FillTransition {
  position: PaperPosition | null;
  realizedPnl: string;
  fee: string;
  cashAfter(cashBefore: string): string;
}

export interface VolumeFeeTier {
  minimumVolume: string;
  makerRate: string;
  takerRate: string;
}

export interface MakerFractionTier {
  minimumMakerFraction: string;
  makerRate: string;
}

export interface FeeSchedule {
  volumeTiers: VolumeFeeTier[];
  makerFractionTiers: MakerFractionTier[];
}

export interface MarginTier {
  lowerBound: string;
  maxLeverage: number;
  maintenanceRate: string;
  maintenanceDeduction: string;
}

export interface PaperAssetMetadata {
  asset: string;
  dex: string;
  collateralToken: number;
  sizeDecimals: number;
  maxLeverage: number;
  marginTableId: number;
  onlyIsolated: boolean;
  marginMode: string | null;
  growthMode: string | null;
  deployerFeeScale: string | null;
  marginTiers: MarginTier[];
}

export interface CrossRiskPosition {
  unrealizedPnl: string;
  maintenanceMargin: string;
}

export interface LiquidationInput {
  positionNotional: string;
  absoluteSize: string;
  equity: string;
  maintenanceMargin: string;
  nowMs: number;
  partialCooldownActive?: boolean;
}

export interface LiquidationDecision {
  action: "none" | "partial" | "book" | "backstop";
  liquidationSize: string;
  cooldownUntilMs: number | null;
}
