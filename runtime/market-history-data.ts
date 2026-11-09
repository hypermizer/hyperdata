export interface HistoryAsset {
  asset: string;
  dex: string;
  index: number;
}
export function historyCatalog(dexes: unknown, metas: unknown): HistoryAsset[] {
  if (
    !Array.isArray(dexes) || !Array.isArray(metas) ||
    dexes.length !== metas.length
  ) throw Error("Market metadata mismatch");
  const rows: HistoryAsset[] = [];
  metas.forEach((meta, i) => {
    if (!Array.isArray(meta?.universe)) throw Error("Missing market universe");
    const dex = dexes[i]?.name ?? "";
    meta.universe.forEach(
      (asset: { name?: string; isDelisted?: boolean }, index: number) => {
        if (asset.name && !asset.isDelisted) {
          rows.push({ asset: asset.name, dex, index });
        }
      },
    );
  });
  return rows;
}
export function historySamples(payload: unknown, catalog: HistoryAsset[]) {
  const raw = (payload as { ctxs?: unknown })?.ctxs;
  if (!raw || typeof raw !== "object") return [];
  const byDex = new Map<string, unknown[]>();
  for (const [key, value] of Object.entries(raw)) {
    if (
      Array.isArray(value) && typeof value[0] === "string" &&
      Array.isArray(value[1])
    ) byDex.set(value[0], value[1]);
    else if (Array.isArray(value)) byDex.set(key, value);
  }
  return catalog.flatMap((asset) => {
    const context = byDex.get(asset.dex)?.[asset.index] as
      | { markPx?: unknown }
      | undefined;
    const price = context?.markPx;
    return typeof price === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(price) &&
        Number.isFinite(Number(price)) && Number(price) > 0
      ? [{ asset: asset.asset, price }]
      : [];
  });
}
export function candleHistoryPoints(candles: unknown, now: number) {
  if (!Array.isArray(candles)) throw Error("Invalid candle history");
  const byTime = new Map<number, { time: number; price: number }>();
  for (const row of candles) {
    const end = Number(row?.T), start = Number(row?.t), price = Number(row?.c);
    if (
      !Number.isFinite(start) || !Number.isFinite(end) || start > now ||
      end < start || !Number.isFinite(price) || price <= 0
    ) continue;
    const time = Math.min(end, now);
    byTime.set(time, { time, price });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
export function repairRequestWeight(body: Record<string, unknown>) {
  if (body.type !== "candleSnapshot") return 20;
  const req = body.req as { startTime: number; endTime: number };
  return 20 +
    Math.ceil(
      Math.min(
        5000,
        Math.max(0, Math.ceil((req.endTime - req.startTime) / 300000) + 1),
      ) / 60,
    );
}
