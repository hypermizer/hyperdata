export function applyAssetAnalyticsRows(rows, { averageVolumes, firstSeenAt, priceHistories }) {
  let applied = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const asset = typeof row?.asset === "string" ? row.asset.trim() : "";
    if (!asset) continue;
    const average = row.average_daily_volume === null ? null : Number(row.average_daily_volume);
    if (Number.isFinite(average) && average >= 0) averageVolumes.set(asset, average);
    const firstSeen = Date.parse(row.first_seen_at);
    if (firstSeenAt && Number.isFinite(firstSeen)) firstSeenAt.set(asset, new Date(firstSeen).toISOString());
    const cached = normalizePoints(row.price_history);
    const live = normalizePoints(priceHistories.get(asset));
    priceHistories.set(asset, mergePoints(cached, live));
    applied += 1;
  }
  return applied;
}

function normalizePoints(points) {
  return (Array.isArray(points) ? points : [])
    .map((point) => ({ time: Number(point?.time), price: Number(point?.price) }))
    .filter(({ time, price }) => Number.isFinite(time) && Number.isFinite(price) && price > 0);
}

function mergePoints(cached, live) {
  const byTime = new Map(cached.map((point) => [point.time, point]));
  live.forEach((point) => byTime.set(point.time, point));
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}
