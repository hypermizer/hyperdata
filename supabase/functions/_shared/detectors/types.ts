export type { AlertRule, DetectorModel, DetectorResult, MarketObservation } from "../types.ts";
export interface DetectorContext {
  current: import("../types.ts").MarketObservation;
  reference?: import("../types.ts").MarketObservation;
  model?: import("../types.ts").DetectorModel;
  volatilityState?: import("../types.ts").VolatilityState;
}
