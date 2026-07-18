export function logReturn(current: number, reference: number): number {
  if (!(current > 0) || !(reference > 0)) throw new Error("Prices must be positive");
  return Math.log(current / reference);
}
export function simplePercent(logValue: number): number { return Math.expm1(logValue) * 100; }
