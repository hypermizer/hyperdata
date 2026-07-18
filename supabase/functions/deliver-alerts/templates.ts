export interface NotificationContext {
  asset: string; detector: string; markPrice: number; classification: string; evidence: Record<string, unknown>; bucket: string;
}
const displayAsset = (asset: string) => asset.startsWith("xyz:") ? asset.slice(4) : asset;
export function buildNotification(context: NotificationContext): { subject: string; text: string } {
  const asset = displayAsset(context.asset); const price = `$${context.markPrice.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
  if (context.detector === "fixed_price") {
    return { subject: `HYPERDATA · ${asset} price alert`, text: `HYPERDATA\n${asset} mark is ${price}.\nTriggered ${context.bucket}.` };
  }
  const move = Number(context.evidence.movePercent); const percentile = Number(context.evidence.empiricalPercentile);
  const label = context.classification === "venue_dislocation" ? "venue dislocation" : context.classification === "underlying_move" ? "underlying move" : "large move";
  return { subject: `HYPERDATA · ${asset} ${label}`, text: `HYPERDATA\n${asset} mark ${price} · ${Number.isFinite(move) ? `${move.toFixed(2)}%` : "move"}\n${Number.isFinite(percentile) ? `Empirical percentile ${(percentile * 100).toFixed(2)}% · ` : ""}${label}\nTriggered ${context.bucket}.` };
}
