import { assertEquals } from "@std/assert";
import { buildLiquidationEffect } from "../../process-paper/liquidation.ts";

const book = { asset: "ORCL", timestampMs: 10_000, bids: [{ price: "99", size: "4", orders: 1 }], asks: [{ price: "101", size: "4", orders: 1 }] };

Deno.test("book liquidation closes a small breached long at visible depth", () => {
  const effect = buildLiquidationEffect({
    asset: "ORCL", position: { signedSize: "2", entryPrice: "110" }, markPrice: "100",
    equity: "40", maintenanceMargin: "50", book, feeRate: "0.001", inputVersion: "v1", nowMs: 10_000,
  })!;
  assertEquals(effect.classification, "book");
  assertEquals(effect.position, null);
  assertEquals(effect.fills[0], { price: "99", size: "2", fee: "0.198", liquidity: "liquidation", sourceId: "v1:liquidation:0" });
});

Deno.test("backstop closes residual size only after visible book", () => {
  const effect = buildLiquidationEffect({
    asset: "ORCL", position: { signedSize: "10", entryPrice: "110" }, markPrice: "100",
    equity: "20", maintenanceMargin: "50", book, feeRate: "0", inputVersion: "v2", nowMs: 10_000,
  })!;
  assertEquals(effect.classification, "backstop");
  assertEquals(effect.fills.map(({ price, size }) => ({ price, size })), [
    { price: "99", size: "4" }, { price: "100", size: "6" },
  ]);
  assertEquals(effect.position, null);
});

Deno.test("healthy position produces no effect", () => {
  assertEquals(buildLiquidationEffect({
    asset: "ORCL", position: { signedSize: "2", entryPrice: "100" }, markPrice: "100",
    equity: "100", maintenanceMargin: "50", book, feeRate: "0", inputVersion: "v", nowMs: 0,
  }), null);
});
