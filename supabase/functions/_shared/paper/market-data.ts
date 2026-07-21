import { decimal, decimalString } from "./decimal.ts";
import type { FeeSchedule, MarginTier, PaperAssetMetadata } from "./types.ts";
import { infoRequest } from "../hyperliquid.ts";

interface RawMarginTier { lowerBound: string; maxLeverage: number }
interface RawMarginTable { marginTiers?: RawMarginTier[] }
interface RawUniverseAsset {
  name?: string;
  szDecimals?: number;
  maxLeverage?: number;
  marginTableId?: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: string;
  growthMode?: string;
}
interface RawPerpMeta {
  collateralToken?: number;
  universe?: RawUniverseAsset[];
  marginTables?: Array<[number, RawMarginTable]>;
}
interface RawPerpDex { name?: string | null; deployerFeeScale?: string }

export function deriveMarginTiers(rawTiers: RawMarginTier[]): MarginTier[] {
  const sorted = [...rawTiers].sort((a, b) => decimal(a.lowerBound).comparedTo(b.lowerBound));
  let priorRate = decimal(0);
  let priorDeduction = decimal(0);
  return sorted.map((tier, index) => {
    if (!Number.isInteger(tier.maxLeverage) || tier.maxLeverage <= 0) {
      throw new Error("invalid margin tier leverage");
    }
    const rate = decimal(1).div(tier.maxLeverage * 2);
    const lowerBound = decimal(tier.lowerBound);
    const deduction = index === 0
      ? decimal(0)
      : lowerBound.times(rate.minus(priorRate)).plus(priorDeduction);
    priorRate = rate;
    priorDeduction = deduction;
    return {
      lowerBound: decimalString(lowerBound),
      maxLeverage: tier.maxLeverage,
      maintenanceRate: decimalString(rate),
      maintenanceDeduction: decimalString(deduction),
    };
  });
}

export function normalizePerpCatalog(
  dexes: RawPerpDex[],
  metas: RawPerpMeta[],
): PaperAssetMetadata[] {
  if (dexes.length !== metas.length) throw new Error("perp DEX metadata mismatch");
  const catalog: PaperAssetMetadata[] = [];
  metas.forEach((meta, dexIndex) => {
    if (meta.collateralToken !== 0) return;
    const dex = dexes[dexIndex]?.name ?? "";
    const tables = new Map(meta.marginTables ?? []);
    for (const rawAsset of meta.universe ?? []) {
      if (rawAsset.isDelisted) continue;
      if (!rawAsset.name || !Number.isInteger(rawAsset.szDecimals) ||
        !Number.isInteger(rawAsset.maxLeverage)) {
        throw new Error("malformed perp asset metadata");
      }
      const marginTableId = Number.isInteger(rawAsset.marginTableId)
        ? rawAsset.marginTableId!
        : rawAsset.maxLeverage!;
      let rawTiers = tables.get(marginTableId)?.marginTiers;
      if (!rawTiers?.length && marginTableId === rawAsset.maxLeverage) {
        rawTiers = [{ lowerBound: "0", maxLeverage: rawAsset.maxLeverage! }];
      }
      if (!rawTiers?.length) {
        throw new Error(`missing margin table ${marginTableId} for ${rawAsset.name}`);
      }
      catalog.push({
        asset: rawAsset.name,
        dex,
        collateralToken: 0,
        sizeDecimals: rawAsset.szDecimals!,
        maxLeverage: rawAsset.maxLeverage!,
        marginTableId,
        onlyIsolated: rawAsset.onlyIsolated === true,
        marginMode: rawAsset.marginMode ?? null,
        growthMode: rawAsset.growthMode ?? null,
        deployerFeeScale: dexes[dexIndex]?.deployerFeeScale ?? null,
        marginTiers: deriveMarginTiers(rawTiers),
      });
    }
  });
  return catalog;
}

export interface BookLevel { price: string; size: string; orders: number }
export interface NormalizedBook {
  asset: string;
  timestampMs: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

export function normalizeBook(payload: unknown): NormalizedBook {
  if (!payload || typeof payload !== "object") throw new Error("malformed L2 book");
  const raw = payload as { coin?: unknown; time?: unknown; levels?: unknown };
  if (typeof raw.coin !== "string" || !Number.isSafeInteger(raw.time) ||
    !Array.isArray(raw.levels) || raw.levels.length !== 2) {
    throw new Error("malformed L2 book");
  }
  const normalizeSide = (side: unknown): BookLevel[] => {
    if (!Array.isArray(side)) throw new Error("malformed L2 levels");
    return side.map((level) => {
      const item = level as { px?: unknown; sz?: unknown; n?: unknown };
      if (typeof item.px !== "string" || typeof item.sz !== "string" ||
        !decimal(item.px).isPositive() || !decimal(item.sz).isPositive() ||
        !Number.isInteger(item.n) || Number(item.n) <= 0) {
        throw new Error("malformed L2 level");
      }
      return { price: item.px, size: item.sz, orders: Number(item.n) };
    });
  };
  return {
    asset: raw.coin,
    timestampMs: Number(raw.time),
    bids: normalizeSide(raw.levels[0]),
    asks: normalizeSide(raw.levels[1]),
  };
}

export interface TradeCursor { lastTradeId: string | null; lastTimestampMs: number | null }
export interface NormalizedTrade {
  id: string;
  timestampMs: number;
  price: string;
  size: string;
  aggressor: "buy" | "sell";
}

function compareTradeIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  }
  return left.localeCompare(right);
}

export function normalizeTrades(payload: unknown, cursor: TradeCursor): {
  trades: NormalizedTrade[];
  cursor: TradeCursor;
  gap: boolean;
} {
  if (!Array.isArray(payload)) throw new Error("malformed recent trades");
  const parsed = payload.map((raw): NormalizedTrade => {
    const item = raw as { tid?: unknown; time?: unknown; px?: unknown; sz?: unknown; side?: unknown };
    if ((typeof item.tid !== "number" && typeof item.tid !== "string") ||
      !Number.isSafeInteger(item.time) || typeof item.px !== "string" ||
      typeof item.sz !== "string" || !["A", "B"].includes(String(item.side))) {
      throw new Error("malformed recent trade");
    }
    return {
      id: String(item.tid),
      timestampMs: Number(item.time),
      price: item.px,
      size: item.sz,
      aggressor: item.side === "B" ? "buy" : "sell",
    };
  });
  parsed.sort((a, b) => a.timestampMs - b.timestampMs || compareTradeIds(a.id, b.id));
  if (parsed.length === 0) return { trades: [], cursor, gap: false };

  let newTrades = parsed;
  if (cursor.lastTradeId !== null) {
    const overlapIndex = parsed.findIndex((trade) => trade.id === cursor.lastTradeId);
    if (overlapIndex < 0) {
      const latest = parsed[parsed.length - 1];
      return {
        trades: [],
        cursor: { lastTradeId: latest.id, lastTimestampMs: latest.timestampMs },
        gap: true,
      };
    }
    newTrades = parsed.slice(overlapIndex + 1);
  }
  const latest = parsed[parsed.length - 1];
  return {
    trades: newTrades,
    cursor: { lastTradeId: latest.id, lastTimestampMs: latest.timestampMs },
    gap: false,
  };
}

export interface FundingRatePoint {
  asset: string;
  timestampMs: number;
  fundingRate: string;
  premium: string | null;
}

export function normalizeFundingHistory(payload: unknown): FundingRatePoint[] {
  if (!Array.isArray(payload)) throw new Error("malformed funding history");
  const unique = new Map<string, FundingRatePoint>();
  for (const raw of payload) {
    const item = raw as { coin?: unknown; time?: unknown; fundingRate?: unknown; premium?: unknown };
    if (typeof item.coin !== "string" || !Number.isSafeInteger(item.time) ||
      typeof item.fundingRate !== "string" ||
      (item.premium !== undefined && typeof item.premium !== "string")) {
      throw new Error("malformed funding point");
    }
    decimal(item.fundingRate);
    if (item.premium !== undefined) decimal(item.premium);
    unique.set(`${item.coin}:${item.time}`, {
      asset: item.coin,
      timestampMs: Number(item.time),
      fundingRate: item.fundingRate,
      premium: typeof item.premium === "string" ? item.premium : null,
    });
  }
  return [...unique.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

export function normalizeFeeSchedule(payload: unknown): FeeSchedule {
  const root = payload as {
    feeSchedule?: {
      cross?: unknown;
      add?: unknown;
      tiers?: { vip?: unknown; mm?: unknown };
    };
  };
  const schedule = root?.feeSchedule;
  if (!schedule || typeof schedule.cross !== "string" || typeof schedule.add !== "string" ||
    !Array.isArray(schedule.tiers?.vip) || !Array.isArray(schedule.tiers?.mm)) {
    throw new Error("malformed fee schedule");
  }
  const volumeTiers = [{
    minimumVolume: "0",
    makerRate: decimalString(schedule.add),
    takerRate: decimalString(schedule.cross),
  }];
  for (const raw of schedule.tiers.vip) {
    const item = raw as { ntlCutoff?: unknown; add?: unknown; cross?: unknown };
    if (typeof item.ntlCutoff !== "string" || typeof item.add !== "string" || typeof item.cross !== "string") {
      throw new Error("malformed VIP fee tier");
    }
    volumeTiers.push({
      minimumVolume: decimalString(item.ntlCutoff),
      makerRate: decimalString(item.add),
      takerRate: decimalString(item.cross),
    });
  }
  const makerFractionTiers = schedule.tiers.mm.map((raw) => {
    const item = raw as { makerFractionCutoff?: unknown; add?: unknown };
    if (typeof item.makerFractionCutoff !== "string" || typeof item.add !== "string") {
      throw new Error("malformed maker fee tier");
    }
    return {
      minimumMakerFraction: decimalString(item.makerFractionCutoff),
      makerRate: decimalString(item.add),
    };
  });
  return { volumeTiers, makerFractionTiers };
}

export class RequestBudget {
  #used = 0;
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error("invalid request budget");
  }
  get used(): number { return this.#used; }
  tryConsume(weight: number): boolean {
    if (!Number.isInteger(weight) || weight < 0) throw new Error("invalid request weight");
    if (this.#used + weight > this.limit) return false;
    this.#used += weight;
    return true;
  }
}

export const INFO_REQUEST_WEIGHTS = {
  perpDexs: 20,
  allPerpMetas: 20,
  l2Book: 2,
  recentTrades: 20,
  fundingHistory: 20,
  userFees: 20,
} as const;

export async function inputVersion(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchPaperCatalog(
  fetchImpl: typeof fetch = fetch,
  retries = 2,
): Promise<{ assets: PaperAssetMetadata[]; inputVersion: string }> {
  const [dexes, metas] = await Promise.all([
    infoRequest({ type: "perpDexs" }, fetchImpl, retries),
    infoRequest({ type: "allPerpMetas" }, fetchImpl, retries),
  ]);
  if (!Array.isArray(dexes) || !Array.isArray(metas)) throw new Error("malformed perp catalog response");
  return {
    assets: normalizePerpCatalog(dexes, metas),
    inputVersion: await inputVersion({ dexes, metas }),
  };
}

export async function fetchPaperBook(
  asset: string,
  fetchImpl: typeof fetch = fetch,
  retries = 2,
): Promise<{ book: NormalizedBook; inputVersion: string }> {
  const payload = await infoRequest({ type: "l2Book", coin: asset, nSigFigs: null }, fetchImpl, retries);
  return { book: normalizeBook(payload), inputVersion: await inputVersion(payload) };
}

export async function fetchPaperTrades(
  asset: string,
  cursor: TradeCursor,
  fetchImpl: typeof fetch = fetch,
  retries = 2,
) {
  const payload = await infoRequest({ type: "recentTrades", coin: asset }, fetchImpl, retries);
  return { ...normalizeTrades(payload, cursor), inputVersion: await inputVersion(payload) };
}

export async function fetchPaperFunding(
  asset: string,
  startTime: number,
  endTime: number,
  fetchImpl: typeof fetch = fetch,
  retries = 2,
) {
  const payload = await infoRequest({ type: "fundingHistory", coin: asset, startTime, endTime }, fetchImpl, retries);
  return { points: normalizeFundingHistory(payload), inputVersion: await inputVersion(payload) };
}

export async function fetchPaperFeeSchedule(fetchImpl: typeof fetch = fetch, retries = 2) {
  const payload = await infoRequest({
    type: "userFees",
    user: "0x0000000000000000000000000000000000000000",
  }, fetchImpl, retries);
  return { schedule: normalizeFeeSchedule(payload), inputVersion: await inputVersion(payload) };
}
