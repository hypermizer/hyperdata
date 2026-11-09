export const LIQUIDATION_RANGE = 10;
export const LIQUIDATION_BUCKETS = 100;
export function liquidationAsset(input: unknown): string {
  if (
    typeof input !== "string" || input.length > 100 ||
    !/^[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.-]+)?$/.test(input)
  ) {
    throw new Error("Choose a perpetual market supported by 0xArchive.");
  }
  return input;
}
export function liquidationPath(asset: string) {
  liquidationAsset(asset);
  return `/v1/hyperliquid/${asset.includes(":") ? "hip3/" : ""}liquidations/${
    encodeURIComponent(asset)
  }/levels`;
}
export interface LiquidationLevel {
  price: number;
  long_notional: number;
  short_notional: number;
  long_count: number;
  short_count: number;
}
export interface LiquidationSnapshot {
  snapshot_ts: string;
  snapshot_ts_ms: number;
  block_number: number;
  mid_price: number;
  total_long: number;
  total_short: number;
  flagged_notional: number;
  levels: LiquidationLevel[];
  source: "raw" | "histogram" | "unknown";
  source_bin_width?: number;
}
function finite(input: unknown, positive = false) {
  if (
    typeof input !== "number" || !Number.isFinite(input) ||
    (positive ? input <= 0 : input < 0)
  ) {
    throw new Error("Invalid numeric liquidation data");
  }
  return input;
}
export function normalizeLiquidationSnapshot(
  input: unknown,
  now = Date.now(),
): LiquidationSnapshot {
  if (!input || typeof input !== "object") throw new Error("Invalid snapshot");
  const d = input as Record<string, unknown>;
  const rawTime = String(d.snapshot_ts ?? "");
  const time = typeof d.snapshot_ts_ms === "number"
    ? d.snapshot_ts_ms
    : Date.parse(
      /Z$|[+-]\d\d:\d\d$/.test(rawTime)
        ? rawTime
        : rawTime.replace(" ", "T") + "Z",
    );
  if (
    !Number.isSafeInteger(time) || time < Date.UTC(2026, 6, 27) ||
    time > now + 60_000
  ) throw new Error("Invalid snapshot time");
  if (!Number.isSafeInteger(d.block_number) || Number(d.block_number) < 1) {
    throw new Error("Invalid snapshot block");
  }
  if (!Array.isArray(d.levels) || d.levels.length > 200) {
    throw new Error("Invalid liquidation buckets");
  }
  const levels = d.levels.map((v): LiquidationLevel => {
    if (!v || typeof v !== "object") throw new Error("Invalid bucket");
    const r = v as Record<string, unknown>;
    const level = {
      price: finite(r.price, true),
      long_notional: finite(r.long_notional),
      short_notional: finite(r.short_notional),
      long_count: finite(r.long_count),
      short_count: finite(r.short_count),
    };
    if (
      !Number.isSafeInteger(level.long_count) ||
      !Number.isSafeInteger(level.short_count)
    ) throw new Error("Invalid position counts");
    return level;
  }).sort((a, b) => a.price - b.price);
  if (levels.some((r, i) => i > 0 && r.price === levels[i - 1].price)) {
    throw new Error("Duplicate bucket prices");
  }
  const source = d.source === "raw" || d.source === "histogram"
    ? d.source
    : "unknown";
  return {
    snapshot_ts: new Date(time).toISOString(),
    snapshot_ts_ms: time,
    block_number: Number(d.block_number),
    mid_price: finite(d.mid_price, true),
    total_long: finite(d.total_long),
    total_short: finite(d.total_short),
    flagged_notional: finite(d.flagged_notional),
    levels,
    source,
    ...(d.source_bin_width !== undefined
      ? { source_bin_width: finite(d.source_bin_width, true) }
      : {}),
  };
}
export class LiquidationProviderError extends Error {
  constructor(
    public status: number,
    public code: string,
    public retrySeconds = 300,
  ) {
    super("0xArchive request unavailable");
  }
}
export async function fetchLiquidations(
  asset: string,
  key: string,
  query: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
) {
  const history = query.start !== undefined;
  const url = new URL(
    liquidationPath(asset) + (history ? "/history" : ""),
    "https://api.0xarchive.io",
  );
  url.search = new URLSearchParams({
    range_pct: String(LIQUIDATION_RANGE),
    buckets: String(LIQUIDATION_BUCKETS),
    ...query,
  }).toString();
  const response = await fetchImpl(url, {
    headers: { "X-API-Key": key, "0xArchive-Version": "2026-10-01" },
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  // Bound upstream memory even on a malformed response.
  const reader = response.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (!reader) throw new Error("Empty provider response");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8_000_000) throw new Error("Provider response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (!response.ok || body.success !== true) {
    const code = /^[a-z_]{1,60}$/.test(body.error_code ?? "")
      ? body.error_code
      : "provider_unavailable";
    const retry = Number(
      response.headers.get("retry-after") ?? body.retry_after,
    );
    throw new LiquidationProviderError(
      response.status,
      code,
      Number.isFinite(retry) && retry > 0 ? Math.min(3600, retry) : 300,
    );
  }
  if (body.meta?.symbol && body.meta.symbol !== asset) {
    throw new Error("Provider returned another asset");
  }
  const input = history ? body.data : [body.data];
  if (!Array.isArray(input) || input.length > 100) {
    throw new Error("Invalid snapshot collection");
  }
  const snapshots = input.map((r) => normalizeLiquidationSnapshot(r));
  const headerNumber = (name: string) => {
    const raw = response.headers.get(name);
    const n = Number(raw);
    return raw !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const cursor = body.meta?.next_cursor;
  if (cursor != null && (typeof cursor !== "string" || cursor.length > 500)) {
    throw new Error("Invalid pagination cursor");
  }
  if (history && body.meta?.has_more === true && !cursor) {
    throw new Error("Missing history cursor");
  }
  return {
    snapshots,
    next: history && body.meta?.has_more !== false ? cursor ?? null : null,
    creditsRemaining: headerNumber("x-credits-remaining"),
    creditsReset: headerNumber("x-credits-reset"),
  };
}
