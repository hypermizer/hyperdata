import { assertEquals } from "@std/assert";
import { validateOrderConstraints } from "../../_shared/paper/constraints.ts";

const asset = {
  asset: "xyz:ORCL",
  dex: "xyz",
  collateralToken: 0,
  sizeDecimals: 4,
  maxLeverage: 20,
  marginTableId: 50,
  onlyIsolated: false,
  marginMode: null,
  growthMode: null,
  deployerFeeScale: null,
  marginTiers: [],
};

Deno.test("valid order respects size, price, notional, leverage, and market state", () => {
  assertEquals(validateOrderConstraints(asset, {
    size: "0.1000",
    price: "100.12",
    leverage: 10,
    marginMode: "cross",
    marketState: "open",
  }), []);
});

Deno.test("invalid order reports every deterministic constraint", () => {
  assertEquals(validateOrderConstraints({ ...asset, onlyIsolated: true }, {
    size: "0.00001",
    price: "100.123",
    leverage: 21,
    marginMode: "cross",
    marketState: "closed",
  }), ["size_precision", "price_precision", "minimum_notional", "maximum_leverage", "isolated_only", "market_closed"]);
});

Deno.test("stale context suspends execution even with a valid mark", () => {
  assertEquals(validateOrderConstraints(asset, {
    size: "1",
    price: "100",
    leverage: 1,
    marginMode: "cross",
    marketState: "stale",
  }), ["market_stale"]);
});

Deno.test("scientific notation is checked after exponent expansion", () => {
  assertEquals(validateOrderConstraints({ ...asset, sizeDecimals: 2 }, {
    size: "1e-3",
    price: "10000",
    leverage: 1,
    marginMode: "cross",
    marketState: "open",
  }), ["size_precision"]);
});
