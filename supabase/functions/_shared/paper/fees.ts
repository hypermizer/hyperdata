import { decimal, decimalString } from "./decimal.ts";
import type { FeeSchedule, Liquidity, VolumeFeeTier } from "./types.ts";

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
