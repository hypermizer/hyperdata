import { assertEquals } from "@std/assert";
import { applyFill, fundingCashFlow, unrealizedPnl } from "../../_shared/paper/accounting.ts";
import { decimalString } from "../../_shared/paper/decimal.ts";

Deno.test("long position adds, reduces, closes, and flips deterministically", () => {
  const opened = applyFill(null, { side: "buy", size: "2", price: "100", feeRate: "0.00045" });
  assertEquals(opened.position, { signedSize: "2", entryPrice: "100" });
  assertEquals(opened.realizedPnl, "0");
  assertEquals(opened.fee, "0.09");

  const added = applyFill(opened.position, { side: "buy", size: "1", price: "130", feeRate: "0" });
  assertEquals(added.position, { signedSize: "3", entryPrice: "110" });

  const reduced = applyFill(added.position, { side: "sell", size: "1", price: "125", feeRate: "0" });
  assertEquals(reduced.position, { signedSize: "2", entryPrice: "110" });
  assertEquals(reduced.realizedPnl, "15");

  const closed = applyFill(reduced.position, { side: "sell", size: "2", price: "105", feeRate: "0" });
  assertEquals(closed.position, null);
  assertEquals(closed.realizedPnl, "-10");

  const flipped = applyFill(added.position, { side: "sell", size: "5", price: "120", feeRate: "0" });
  assertEquals(flipped.position, { signedSize: "-2", entryPrice: "120" });
  assertEquals(flipped.realizedPnl, "30");
});

Deno.test("short position realizes pnl with the correct sign", () => {
  const short = applyFill(null, { side: "sell", size: "4", price: "100", feeRate: "0" });
  const reduced = applyFill(short.position, { side: "buy", size: "1.5", price: "80", feeRate: "0" });
  assertEquals(reduced.position, { signedSize: "-2.5", entryPrice: "100" });
  assertEquals(reduced.realizedPnl, "30");
  assertEquals(unrealizedPnl(reduced.position!, "90"), "25");
});

Deno.test("multi-level fills conserve cash without binary floating point drift", () => {
  let position = null;
  let cash = "5000";
  for (const fill of [
    { side: "buy" as const, size: "0.5", price: "100", feeRate: "0.00045" },
    { side: "buy" as const, size: "0.25", price: "101", feeRate: "0.00045" },
  ]) {
    const result = applyFill(position, fill);
    position = result.position;
    cash = result.cashAfter(cash);
  }
  assertEquals(position, { signedSize: "0.75", entryPrice: "100.33333333333333333333" });
  assertEquals(cash, "4999.9661375");
});

Deno.test("funding cash flow debits positive-rate longs and credits shorts", () => {
  assertEquals(fundingCashFlow("2", "100", "0.0001"), "-0.02");
  assertEquals(fundingCashFlow("-2", "100", "0.0001"), "0.02");
  assertEquals(fundingCashFlow("2", "100", "-0.0001"), "0.02");
});

Deno.test("negative maker fee rate credits a rebate to cash", () => {
  const result = applyFill(null, { side: "buy", size: "2", price: "100", feeRate: "-0.00001" });
  assertEquals(result.fee, "-0.002");
  assertEquals(result.cashAfter("5000"), "5000.002");
});

Deno.test("extreme valid decimals remain exact and negative zero is normalized", () => {
  assertEquals(
    fundingCashFlow("123456789.123456789", "999999.99999", "0.000000000001"),
    "-123.45678912222222110876543211",
  );
  assertEquals(decimalString("-0.000000000000000000000"), "0");
});
