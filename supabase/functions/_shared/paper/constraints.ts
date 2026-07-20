import { decimal } from "./decimal.ts";
import type { MarginMode, PaperAssetMetadata } from "./types.ts";

interface OrderConstraintInput {
  size: string;
  price: string;
  leverage: number;
  marginMode: MarginMode;
  marketState: "open" | "closed" | "paused" | "stale";
}

function decimalPlaces(value: string): number {
  return decimal(value).decimalPlaces();
}

function significantFigures(value: string): number {
  const plain = value.toLowerCase().split("e")[0].replace(".", "").replace(/^[-+]?0+/, "");
  return plain.replace(/0+$/, "").length;
}

export function validateOrderConstraints(
  asset: PaperAssetMetadata,
  order: OrderConstraintInput,
): string[] {
  const errors: string[] = [];
  const size = decimal(order.size);
  const price = decimal(order.price);
  if (!size.isPositive() || decimalPlaces(order.size) > asset.sizeDecimals) errors.push("size_precision");
  const maximumPriceDecimals = 6 - asset.sizeDecimals;
  if (!price.isPositive() || decimalPlaces(order.price) > maximumPriceDecimals || significantFigures(order.price) > 5) {
    errors.push("price_precision");
  }
  if (size.times(price).lt(10)) errors.push("minimum_notional");
  if (!Number.isInteger(order.leverage) || order.leverage < 1 || order.leverage > asset.maxLeverage) {
    errors.push("maximum_leverage");
  }
  if (asset.onlyIsolated && order.marginMode !== "isolated") errors.push("isolated_only");
  if (order.marketState === "closed" || order.marketState === "paused") errors.push("market_closed");
  if (order.marketState === "stale") errors.push("market_stale");
  return errors;
}
