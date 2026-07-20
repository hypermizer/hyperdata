import { assertEquals } from "@std/assert";
import { buildLiquidationEffect } from "../../process-paper/liquidation.ts";

const book = { asset: "ORCL", timestampMs: 10_000, bids: [{ price: "99", size: "4", orders: 1 }], asks: [{ price: "101", size: "4", orders: 1 }] };
const marginTiers = [{ lowerBound: "0", maxLeverage: 10, maintenanceRate: "0.05", maintenanceDeduction: "0" }];

Deno.test("book liquidation closes a small breached long at visible depth", () => {
  const effect = buildLiquidationEffect({
    asset: "ORCL", position: { signedSize: "2", entryPrice: "110" }, markPrice: "100",
    equity: "40", maintenanceMargin: "50", positionMaintenanceMargin: "10", marginTiers,
    book, feeRate: "0.001", inputVersion: "v1", nowMs: 10_000,
  })!;
  assertEquals(effect.classification, "book");
  assertEquals(effect.position, null);
  assertEquals(effect.fills[0], { price: "99", size: "2", fee: "0.198", liquidity: "liquidation", sourceId: "v1:liquidation:0" });
});

Deno.test("backstop closes residual size only after visible book", () => {
  const effect = buildLiquidationEffect({
    asset: "ORCL", position: { signedSize: "10", entryPrice: "110" }, markPrice: "100",
    equity: "20", maintenanceMargin: "50", positionMaintenanceMargin: "50", marginTiers,
    book, feeRate: "0", inputVersion: "v2", nowMs: 10_000,
  })!;
  assertEquals(effect.classification, "backstop");
  assertEquals(effect.fills.map(({ price, size }) => ({ price, size })), [
    { price: "99", size: "4" }, { price: "100", size: "6" },
  ]);
  assertEquals(effect.position, null);
});

Deno.test("partial liquidation reports maintenance for the remaining position", () => {
  const effect = buildLiquidationEffect({
    asset: "ORCL", position: { signedSize: "1000", entryPrice: "100" }, markPrice: "100",
    equity: "4000", maintenanceMargin: "5000", positionMaintenanceMargin: "5000", marginTiers,
    book: { ...book, bids: [{ price: "99", size: "500", orders: 5 }] },
    feeRate: "0", inputVersion: "v-partial", nowMs: 10_000,
  })!;
  assertEquals(effect.classification, "partial");
  assertEquals(effect.position, { signedSize: "800", entryPrice: "100" });
  assertEquals(effect.remainingPositionMaintenanceMargin, "4000");
});

Deno.test("healthy position produces no effect", () => {
  assertEquals(buildLiquidationEffect({
    asset: "ORCL", position: { signedSize: "2", entryPrice: "100" }, markPrice: "100",
    equity: "100", maintenanceMargin: "50", positionMaintenanceMargin: "10", marginTiers,
    book, feeRate: "0", inputVersion: "v", nowMs: 0,
  }), null);
});
