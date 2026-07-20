import { Decimal as DecimalBase } from "decimal.js";

export const Decimal = DecimalBase.clone({
  precision: 50,
  rounding: DecimalBase.ROUND_HALF_UP,
  toExpNeg: -50,
  toExpPos: 50,
});

export type DecimalInput = DecimalBase.Value;

export function decimal(value: DecimalInput): DecimalBase {
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error("paper decimal must be finite");
  return parsed;
}

export function decimalString(value: DecimalInput): string {
  const parsed = decimal(value);
  return parsed.isZero() ? "0" : parsed.toString();
}

export function fixedDecimal(value: DecimalInput, places = 6): string {
  const parsed = decimal(value);
  const fixed = parsed.toFixed(places);
  return /^-0(?:\.0+)?$/.test(fixed) ? fixed.slice(1) : fixed;
}
