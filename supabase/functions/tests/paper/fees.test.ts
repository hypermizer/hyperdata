import { assertEquals } from "@std/assert";
import { makerFraction, scalePerpFeeRate, selectFeeRate } from "../../_shared/paper/fees.ts";
import type { FeeSchedule } from "../../_shared/paper/types.ts";

const schedule: FeeSchedule = {
  volumeTiers: [
    { minimumVolume: "0", makerRate: "0.00015", takerRate: "0.00045" },
    { minimumVolume: "5000000", makerRate: "0.00012", takerRate: "0.00040" },
  ],
  makerFractionTiers: [
    { minimumMakerFraction: "0.005", makerRate: "-0.00001" },
    { minimumMakerFraction: "0.02", makerRate: "-0.00002" },
  ],
};

Deno.test("volume tier starts exactly at its published boundary", () => {
  assertEquals(selectFeeRate(schedule, "4999999.99", "0", "taker"), "0.00045");
  assertEquals(selectFeeRate(schedule, "5000000", "0", "taker"), "0.0004");
});

Deno.test("maker fraction selects the strongest earned maker rate", () => {
  assertEquals(selectFeeRate(schedule, "0", "0.0049", "maker"), "0.00015");
  assertEquals(selectFeeRate(schedule, "0", "0.005", "maker"), "-0.00001");
  assertEquals(selectFeeRate(schedule, "0", "0.02", "maker"), "-0.00002");
});

Deno.test("maker fraction derives from persisted notional volumes", () => {
  assertEquals(makerFraction("250", "1000"), "0.25");
  assertEquals(makerFraction("0", "0"), "0");
});

Deno.test("HIP-3 growth mode scales positive fees and maker rebates", () => {
  const asset = { dex: "xyz", deployerFeeScale: "1", growthMode: "enabled" };
  assertEquals(scalePerpFeeRate("0.00045", asset, "taker"), "0.00009");
  assertEquals(scalePerpFeeRate("0.00015", asset, "maker"), "0.00003");
  assertEquals(scalePerpFeeRate("-0.00001", asset, "maker"), "-0.000001");
});
