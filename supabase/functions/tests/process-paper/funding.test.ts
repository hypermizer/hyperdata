import { assertEquals } from "@std/assert";
import { missingFundingEffects } from "../../process-paper/funding.ts";

Deno.test("missed funding applies chronologically to strict boundary exposure", () => {
  const effects = missingFundingEffects([
    { asset: "ORCL", timestampMs: 2_000, fundingRate: "0.0002", premium: null },
    { asset: "ORCL", timestampMs: 1_000, fundingRate: "0.0001", premium: null },
    { asset: "ORCL", timestampMs: 3_000, fundingRate: "-0.0001", premium: null },
  ], [
    { side: "buy", size: "2", price: "100", timestampMs: 900 },
    { side: "sell", size: "1", price: "110", timestampMs: 2_000 },
  ], new Set([3_000]), "100", "funding-v1");
  assertEquals(effects.map((effect) => ({ at: effect.fundingTimestamp, size: effect.signedSize, payment: effect.payment })), [
    { at: "1970-01-01T00:00:01.000Z", size: "2", payment: "-0.02" },
    { at: "1970-01-01T00:00:02.000Z", size: "2", payment: "-0.04" },
  ]);
});
