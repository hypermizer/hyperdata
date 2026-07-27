import { assertEquals, assertThrows } from "@std/assert";
import { decimalString } from "../../_shared/paper/decimal.ts";
import type { PaperAssetMetadata } from "../../_shared/paper/types.ts";
import { accountRiskProjection } from "../../process-paper/index.ts";

const btc = {
  asset: "BTC",
  marginTiers: [{ lowerBound: "0", maxLeverage: 40, maintenanceRate: "0.0125", maintenanceDeduction: "0" }],
} as PaperAssetMetadata;

Deno.test("risk projection clears margin after a full liquidation", () => {
  const projection = accountRiskProjection([], new Map([["BTC", btc]]), new Map([["BTC", 40]]));
  assertEquals(decimalString(projection.margin), "0");
  assertEquals(decimalString(projection.maintenance), "0");
});

Deno.test("risk projection recalculates reduced liquidation exposure", () => {
  const projection = accountRiskProjection([{
    asset: "BTC", margin_mode: "cross", signed_size: "0.5", entry_price: "100", mark_price: "120", isolated_margin: null,
  }], new Map([["BTC", btc]]), new Map([["BTC", 10]]));
  assertEquals(decimalString(projection.margin), "6");
  assertEquals(decimalString(projection.maintenance), "0.75");
});

Deno.test("risk projection fails closed when position metadata is unavailable", () => {
  assertThrows(() => accountRiskProjection([{
    asset: "MISSING", margin_mode: "cross", signed_size: "1", entry_price: "100", mark_price: "120", isolated_margin: null,
  }], new Map(), new Map()), Error, "asset_metadata_unavailable:MISSING");
});
