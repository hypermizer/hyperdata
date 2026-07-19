import { assertEquals } from "@std/assert";
import { reconstructPositionAt, reconcileAccount } from "../../_shared/paper/reconciliation.ts";

Deno.test("boundary position excludes fills at and after funding timestamp", () => {
  assertEquals(reconstructPositionAt([
    { side: "buy", size: "2", price: "100", timestampMs: 900 },
    { side: "sell", size: "0.5", price: "110", timestampMs: 1000 },
    { side: "sell", size: "1", price: "120", timestampMs: 1100 },
  ], 1000), { signedSize: "2", entryPrice: "100" });
});

Deno.test("account reconciliation detects corrupted cached equity", () => {
  assertEquals(reconcileAccount({
    cashBalance: "5000", cachedEquity: "5100",
    positions: [{ signedSize: "2", entryPrice: "100", markPrice: "125", isolatedMargin: null }],
  }), { expectedEquity: "5050", difference: "-50", reconciled: false });
  assertEquals(reconcileAccount({
    cashBalance: "5000", cachedEquity: "5050",
    positions: [{ signedSize: "2", entryPrice: "100", markPrice: "125", isolatedMargin: null }],
  }).reconciled, true);
});
