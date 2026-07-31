export interface NotificationContext {
  asset: string; detector: string; markPrice: number; classification: string; evidence: Record<string, unknown>; bucket: string;
}
const displayAsset = (asset: string) => asset.startsWith("xyz:") ? asset.slice(4) : asset;
export function buildNotification(context: NotificationContext): { subject: string; text: string } {
  const asset = displayAsset(context.asset); const price = `$${context.markPrice.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
  if (context.detector === "fixed_price") {
    const direction = context.evidence.direction === "below" ? "below" : "above";
    const targetValue = Number(context.evidence.target);
    const target = Number.isFinite(targetValue)
      ? `$${targetValue.toLocaleString("en-US", { maximumFractionDigits: 6 })}`
      : "configured target";
    const observedAt = typeof context.evidence.observedAt === "string" ? context.evidence.observedAt : context.bucket;
    return {
      subject: `HYPERDATA · ${asset} ${direction} ${target}`,
      text: `HYPERDATA\n${asset} mark ${price} crossed ${direction} target ${target}.\nObserved ${observedAt}.`,
    };
  }
  const move = Number(context.evidence.movePercent); const percentile = Number(context.evidence.empiricalPercentile);
  const label = context.classification === "venue_dislocation" ? "venue dislocation" : context.classification === "underlying_move" ? "underlying move" : "large move";
  return { subject: `HYPERDATA · ${asset} ${label}`, text: `HYPERDATA\n${asset} mark ${price} · ${Number.isFinite(move) ? `${move.toFixed(2)}%` : "move"}\n${Number.isFinite(percentile) ? `Empirical percentile ${(percentile * 100).toFixed(2)}% · ` : ""}${label}\nTriggered ${context.bucket}.` };
}
