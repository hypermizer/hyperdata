export type DetectorName = "fixed_price" | "large_move";
export type DeliveryChannel = "email" | "sms";

export interface AlertRule {
  id: string; user_id: string; asset: string; dex: string;
  detector: DetectorName; detector_version: number;
  configuration: Record<string, unknown>; delivery: DeliveryChannel;
  enabled: boolean; deleted_at: string | null;
}

export interface MarketObservation {
  asset: string; dex: string; bucket: string; observed_at: string;
  mark_price: number; oracle_price: number | null; mid_price: number | null;
  open_interest: number | null; day_volume: number | null;
}

export interface DetectorModel {
  asset: string; horizon_minutes: number; model_version: string;
  source: "trade_candle_bootstrap" | "mark_history";
  parameters: {
    fastVariance: number; slowVariance: number; sessionFactor: number; absoluteScores: number[];
    sessionFactors?: Record<string, number>; absoluteScoresBySession?: Record<string, number[]>;
    regimeThresholds?: [number, number]; absoluteScoresByRegime?: Record<string, number[]>;
    absoluteScoresBySessionRegime?: Record<string, number[]>;
  };
  sample_count: number; expires_at: string;
}

export interface VolatilityState {
  asset: string; fast_variance: number; slow_variance: number; last_mark: number; last_bucket: string;
}

export interface DetectorResult {
  status: "not_triggered" | "triggered" | "warming" | "data_gap" | "error";
  qualifies: boolean; score: number | null; tailPercentile: number | null;
  classification: "fixed_price" | "underlying_move" | "venue_dislocation" | "uncertain";
  evidence: Record<string, unknown>; modelVersion: string | null; referenceAgeSeconds: number | null;
}
