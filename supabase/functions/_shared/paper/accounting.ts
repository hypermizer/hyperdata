import { decimal, decimalString } from "./decimal.ts";
import type { FillInput, FillTransition, PaperPosition } from "./types.ts";

export function unrealizedPnl(position: PaperPosition, markPrice: string): string {
  return decimalString(
    decimal(markPrice).minus(position.entryPrice).times(position.signedSize),
  );
}

export function fundingCashFlow(
  signedSize: string,
  oraclePrice: string,
  fundingRate: string,
): string {
  return decimalString(
    decimal(signedSize).times(oraclePrice).times(fundingRate).negated(),
  );
}

export function applyFill(
  current: PaperPosition | null,
  fill: FillInput,
): FillTransition {
  const fillSize = decimal(fill.size);
  const fillPrice = decimal(fill.price);
  const signedFill = fill.side === "buy" ? fillSize : fillSize.negated();
  if (!fillSize.isPositive() || !fillPrice.isPositive()) {
    throw new Error("fill size and price must be positive");
  }

  const fee = fillSize.times(fillPrice).times(fill.feeRate);
  let nextPosition: PaperPosition | null;
  let realized = decimal(0);

  if (!current) {
    nextPosition = {
      signedSize: decimalString(signedFill),
      entryPrice: decimalString(fillPrice),
    };
  } else {
    const currentSize = decimal(current.signedSize);
    const currentEntry = decimal(current.entryPrice);
    const sameDirection = currentSize.isPositive() === signedFill.isPositive();

    if (sameDirection) {
      const nextSize = currentSize.plus(signedFill);
      const weightedEntry = currentSize.abs().times(currentEntry)
        .plus(signedFill.abs().times(fillPrice))
        .div(nextSize.abs());
      nextPosition = {
        signedSize: decimalString(nextSize),
        entryPrice: decimalString(weightedEntry.toDecimalPlaces(20)),
      };
    } else {
      const currentAbsolute = currentSize.abs();
      const fillAbsolute = signedFill.abs();
      const closingSize = currentAbsolute.lte(fillAbsolute) ? currentAbsolute : fillAbsolute;
      realized = fillPrice.minus(currentEntry).times(closingSize)
        .times(currentSize.isPositive() ? 1 : -1);
      const nextSize = currentSize.plus(signedFill);
      if (nextSize.isZero()) {
        nextPosition = null;
      } else if (currentSize.isPositive() === nextSize.isPositive()) {
        nextPosition = {
          signedSize: decimalString(nextSize),
          entryPrice: decimalString(currentEntry),
        };
      } else {
        nextPosition = {
          signedSize: decimalString(nextSize),
          entryPrice: decimalString(fillPrice),
        };
      }
    }
  }

  return {
    position: nextPosition,
    realizedPnl: decimalString(realized),
    fee: decimalString(fee),
    cashAfter(cashBefore: string): string {
      return decimalString(decimal(cashBefore).plus(realized).minus(fee));
    },
  };
}
