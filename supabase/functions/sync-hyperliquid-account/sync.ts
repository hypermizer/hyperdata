const API_URL = "https://api.hyperliquid.xyz/info";
const CURSOR_OVERLAP_MS = 5 * 60_000;
const PAGE_SIZE = 2_000;
const MAX_PAGES = 10;

type JsonRecord = Record<string, unknown>;
export type InfoFetch = (body: JsonRecord) => Promise<unknown>;

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`malformed ${name}`);
  return value as JsonRecord;
}

function text(value: unknown, name: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") throw new Error(`malformed ${name}`);
  return String(value);
}

function decimal(value: unknown, name: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const result = text(value, name);
  if (!Number.isFinite(Number(result))) throw new Error(`malformed ${name}`);
  return result;
}

function timestamp(value: unknown): { occurred_at_ms: number; occurred_at: string } {
  const occurred_at_ms = Number(value);
  if (!Number.isSafeInteger(occurred_at_ms) || occurred_at_ms < 0) throw new Error("malformed event time");
  return { occurred_at_ms, occurred_at: new Date(occurred_at_ms).toISOString() };
}

function canonicalAsset(coin: unknown, dex = ""): string {
  const asset = text(coin, "asset");
  return dex && !asset.includes(":") ? `${dex}:${asset}` : asset;
}

export function normalizeFill(userId: string, address: string, input: unknown) {
  const raw = record(input, "fill");
  const side = text(raw.side, "fill side");
  if (side !== "A" && side !== "B") throw new Error("malformed fill side");
  return {
    user_id: userId,
    account_address: address,
    trade_id: text(raw.tid, "trade id"),
    ...timestamp(raw.time),
    asset: canonicalAsset(raw.coin),
    side: side === "B" ? "buy" : "sell",
    direction: text(raw.dir, "fill direction"),
    price: decimal(raw.px, "fill price"),
    size: decimal(raw.sz, "fill size"),
    start_position: decimal(raw.startPosition, "start position", true),
    closed_pnl: decimal(raw.closedPnl ?? "0", "closed pnl"),
    fee: decimal(raw.fee ?? "0", "fee"),
    fee_token: raw.feeToken == null ? null : text(raw.feeToken, "fee token"),
    crossed: typeof raw.crossed === "boolean" ? raw.crossed : null,
    order_id: text(raw.oid, "order id"),
    transaction_hash: raw.hash == null ? null : text(raw.hash, "transaction hash"),
    twap_id: raw.twapId == null ? null : text(raw.twapId, "twap id"),
    raw,
  };
}

export function normalizeFunding(userId: string, address: string, input: unknown) {
  const raw = record(input, "funding event");
  const delta = record(raw.delta, "funding delta");
  const eventTime = timestamp(raw.time);
  const asset = canonicalAsset(delta.coin);
  const hash = raw.hash == null ? "no-hash" : text(raw.hash, "funding hash");
  return {
    user_id: userId, account_address: address, event_key: `${hash}:${eventTime.occurred_at_ms}:${asset}`,
    ...eventTime, asset,
    funding_rate: decimal(delta.fundingRate, "funding rate", true),
    position_size: decimal(delta.szi, "funding position", true),
    usdc: decimal(delta.usdc, "funding usdc", true),
    transaction_hash: raw.hash == null ? null : hash, raw,
  };
}

export function normalizeLedger(userId: string, address: string, input: unknown) {
  const raw = record(input, "ledger event");
  const delta = record(raw.delta, "ledger delta");
  const eventTime = timestamp(raw.time);
  const event_type = text(delta.type, "ledger type");
  const hash = raw.hash == null ? "no-hash" : text(raw.hash, "ledger hash");
  return {
    user_id: userId, account_address: address,
    event_key: `${hash}:${eventTime.occurred_at_ms}:${event_type}`,
    ...eventTime, event_type, transaction_hash: raw.hash == null ? null : hash, raw,
  };
}

export function normalizePosition(userId: string, address: string, dex: string, observedAtMs: number, input: unknown) {
  const raw = record(input, "asset position");
  const position = record(raw.position, "position");
  const leverage = record(position.leverage, "position leverage");
  return {
    user_id: userId, account_address: address, dex,
    asset: canonicalAsset(position.coin, dex),
    signed_size: decimal(position.szi, "position size"),
    entry_price: decimal(position.entryPx, "entry price", true),
    position_value: decimal(position.positionValue, "position value", true),
    unrealized_pnl: decimal(position.unrealizedPnl, "unrealized pnl", true),
    margin_used: decimal(position.marginUsed, "margin used", true),
    liquidation_price: decimal(position.liquidationPx, "liquidation price", true),
    leverage_type: leverage.type == null ? null : text(leverage.type, "leverage type"),
    leverage: leverage.value == null ? null : Number(leverage.value),
    raw, observed_at: new Date(observedAtMs).toISOString(),
  };
}

export async function fetchInfo(body: JsonRecord): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(API_URL, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return await response.json();
      const detail = (await response.text()).slice(0, 300);
      lastError = new Error(`Hyperliquid info ${response.status}: ${detail}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error("Hyperliquid info request failed");
}

export async function fetchTimeWindow(
  type: "userFillsByTime" | "userFunding" | "userNonFundingLedgerUpdates",
  address: string,
  cursorMs: number | null,
  endTime: number,
  request: InfoFetch = fetchInfo,
) {
  let startTime = Math.max(0, (cursorMs ?? 0) - CURSOR_OVERLAP_MS);
  const items: JsonRecord[] = [];
  let newest = cursorMs ?? 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload: JsonRecord = { type, user: address, startTime, endTime };
    if (type === "userFillsByTime") payload.aggregateByTime = false;
    const response = await request(payload);
    if (!Array.isArray(response)) throw new Error(`malformed ${type} response`);
    const pageItems = response.map((item) => record(item, `${type} item`));
    items.push(...pageItems);
    for (const item of pageItems) newest = Math.max(newest, timestamp(item.time).occurred_at_ms);
    if (pageItems.length < PAGE_SIZE) return { items, cursorMs: newest || cursorMs };
    const nextStart = newest + 1;
    if (nextStart <= startTime) throw new Error(`${type} pagination did not advance`);
    startTime = nextStart;
  }
  throw new Error(`${type} exceeded ${MAX_PAGES * PAGE_SIZE} events in one sync`);
}

export async function fetchPositions(userId: string, address: string, observedAtMs: number, request: InfoFetch = fetchInfo) {
  const dexResponse = await request({ type: "perpDexs" });
  if (!Array.isArray(dexResponse)) throw new Error("malformed perp dex response");
  const dexes = dexResponse.map((item) => item == null ? "" : text(record(item, "perp dex").name, "perp dex name"));
  const states = await Promise.all(dexes.map(async (dex) => {
    const state = record(await request({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) }), "clearinghouse state");
    if (!Array.isArray(state.assetPositions)) throw new Error("malformed clearinghouse positions");
    return state.assetPositions.map((position) => normalizePosition(userId, address, dex, observedAtMs, position));
  }));
  return states.flat();
}
