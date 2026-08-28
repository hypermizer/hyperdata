const LIVE_PRICE_BUCKET_MS = 5 * 60 * 1000;
const PRICE_HISTORY_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;

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

export function recordLivePricePoint(points, price, now = Date.now()) {
  const recent = normalizePoints(points)
    .filter((point) => point.time >= now - PRICE_HISTORY_RETENTION_MS);
  if (!Number.isFinite(price) || price <= 0) return recent;

  const bucket = Math.floor(now / LIVE_PRICE_BUCKET_MS) * LIVE_PRICE_BUCKET_MS;
  if (recent.at(-1)?.time >= bucket) recent[recent.length - 1] = { time: bucket, price };
  else recent.push({ time: bucket, price });
  return recent;
}

export function earliestIsoTimestamp(...values) {
  const timestamps = values.map((value) => Date.parse(value)).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null;
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
