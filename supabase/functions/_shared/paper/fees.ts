import { decimal, decimalString } from "./decimal.ts";
import type { FeeSchedule, Liquidity, PaperAssetMetadata, VolumeFeeTier } from "./types.ts";

function earnedVolumeTier(schedule: FeeSchedule, volume: string): VolumeFeeTier {
  if (schedule.volumeTiers.length === 0) throw new Error("fee schedule has no volume tiers");
  const sorted = [...schedule.volumeTiers].sort((a, b) =>
    decimal(a.minimumVolume).comparedTo(b.minimumVolume)
  );
  let earned = sorted[0];
  for (const tier of sorted) {
    if (decimal(volume).gte(tier.minimumVolume)) earned = tier;
  }
  return earned;
}

export function selectFeeRate(
  schedule: FeeSchedule,
  trailingVolume: string,
  makerFraction: string,
  liquidity: Liquidity,
): string {
  const volumeTier = earnedVolumeTier(schedule, trailingVolume);
  if (liquidity === "taker") return decimalString(volumeTier.takerRate);

  let rate = decimal(volumeTier.makerRate);
  for (const tier of schedule.makerFractionTiers) {
    if (decimal(makerFraction).gte(tier.minimumMakerFraction)) {
      if (rate.gt(tier.makerRate)) rate = decimal(tier.makerRate);
    }
  }
  return decimalString(rate);
}

export function makerFraction(makerVolume: string, totalVolume: string): string {
  const total = decimal(totalVolume);
  if (!total.gt(0)) return "0";
  const maker = decimal(makerVolume);
  return maker.gt(0) ? decimalString(maker.div(total).toString()) : "0";
}

export function scalePerpFeeRate(
  rate: string,
  asset: Pick<PaperAssetMetadata, "dex" | "deployerFeeScale" | "growthMode">,
  liquidity: Liquidity,
): string {
  const base = decimal(rate);
  if (!asset.dex) return decimalString(base);
  const deployer = asset.deployerFeeScale === null ? decimal(0) : decimal(asset.deployerFeeScale);
  const hip3Scale = deployer.lt(1) ? deployer.plus(1) : deployer.times(2);
  const growthScale = asset.growthMode === "enabled" ? decimal("0.1") : decimal(1);
  const scale = liquidity === "maker" && !base.isPositive()
    ? growthScale
    : growthScale.times(hip3Scale);
  return decimalString(base.times(scale));
}
