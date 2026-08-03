export interface AssetIdentity {
  symbol: string;
  yahooSymbol: string | null;
  displayName: string;
  description: string;
  instrumentType: string;
  category: string;
  keywords: string[];
  exchange: string;
  currency: string;
  regularMarketTime: number | null;
  market: Record<string, number | string | boolean | null>;
  source: "hyperliquid+yahoo" | "hyperliquid" | "yahoo+wikipedia" | "yahoo" | "curated";
}

interface PerpAnnotation {
  category: string;
  displayName: string;
  description: string;
  keywords: string[];
}

const YAHOO_OVERRIDES: Record<string, string | null> = {
  BRENTOIL: "BZ=F", CL: "CL=F", COPPER: "HG=F", DRAM: "DRAM", EUR: "EURUSD=X", GBP: "GBPUSD=X", GOLD: "GC=F",
  GIGADEV: "603986.SS", HYUNDAI: "005380.KS", JP225: "^N225", JPY: "JPY=X", KIOXIA: "285A.T",
  KR200: "^KS200", NATGAS: "NG=F", PALLADIUM: "PA=F", PLATINUM: "PL=F", SILVER: "SI=F",
  MINIMAX: "0100.HK", SKHX: "000660.KS", SKHY: "SKHY", SMSN: "005930.KS", SOFTBANK: "9984.T", SP500: "^GSPC",
  VIX: "^VIX", XYZ100: "^NDX", ZHIPU: "2513.HK",
};

const CURATED: Record<string, Pick<AssetIdentity, "displayName" | "description" | "instrumentType">> = {
  BRENTOIL: { displayName: "Brent Crude Oil", description: "Brent is the principal global crude-oil price benchmark, reflecting North Sea supply and the wider balance of global petroleum supply, demand, inventories, and geopolitical risk.", instrumentType: "FUTURE" },
  COPPER: { displayName: "Copper", description: "Copper is an industrial metal whose price is closely linked to construction, manufacturing, electrification, mine supply, inventories, and global economic activity.", instrumentType: "FUTURE" },
  DRAM: { displayName: "DRAM", description: "DRAM is dynamic random-access memory used as working memory in computers, servers, phones, and AI systems. This market tracks the memory-cycle economics of pricing, inventories, capacity, and end demand rather than one public company.", instrumentType: "MARKET" },
  EUR: { displayName: "Euro / U.S. Dollar", description: "EUR/USD is the exchange rate between the euro and U.S. dollar, primarily driven by relative interest rates, central-bank policy, inflation, growth, and cross-border capital flows.", instrumentType: "CURRENCY" },
  GOLD: { displayName: "Gold", description: "Gold is a globally traded precious metal and reserve asset whose price responds to real interest rates, currency conditions, central-bank demand, inflation expectations, and risk aversion.", instrumentType: "FUTURE" },
  SP500: { displayName: "S&P 500 Index", description: "The S&P 500 is a market-capitalization-weighted index of 500 leading U.S. companies and a broad benchmark for large-cap U.S. equities.", instrumentType: "INDEX" },
  XYZ100: { displayName: "Nasdaq-100 Index", description: "The Nasdaq-100 tracks 100 of the largest non-financial companies listed on Nasdaq and is heavily exposed to large technology and growth companies.", instrumentType: "INDEX" },
};

export function bareAssetSymbol(asset: string): string {
  return asset.replace(/^xyz:/i, "").toUpperCase();
}

export function yahooSymbolForAsset(asset: string): string | null {
  const symbol = bareAssetSymbol(asset);
  return Object.hasOwn(YAHOO_OVERRIDES, symbol) ? YAHOO_OVERRIDES[symbol] : symbol;
}

export async function resolveAssetIdentity(
  asset: string,
  options: { includeDescription?: boolean; fetcher?: typeof fetch } = {},
): Promise<AssetIdentity> {
  const fetcher = options.fetcher ?? fetch;
  const symbol = bareAssetSymbol(asset);
  const yahooSymbol = yahooSymbolForAsset(asset);
  const curated = CURATED[symbol];
  const annotationPromise = fetchPerpAnnotation(asset, fetcher);
  const annotation = yahooSymbol ? null : await annotationPromise;
  if (!yahooSymbol) return annotatedIdentity(symbol, annotation, curated);
  const [resolvedAnnotation, meta] = await Promise.all([
    annotationPromise,
    fetchYahooMetadata(yahooSymbol, fetcher),
  ]);
  if (!meta) return { ...annotatedIdentity(symbol, resolvedAnnotation, curated), yahooSymbol };
  const displayName = displayNameForIdentity(meta, resolvedAnnotation, curated, symbol);
  const description = options.includeDescription === false
    ? (resolvedAnnotation?.description || curated?.description || "")
    : (resolvedAnnotation?.description || curated?.description || await fetchWikipediaDescription(displayName, fetcher));
  return {
    symbol,
    yahooSymbol,
    displayName,
    description,
    instrumentType: String(meta.instrumentType || curated?.instrumentType || ""),
    category: resolvedAnnotation?.category || "",
    keywords: resolvedAnnotation?.keywords || [],
    exchange: String(meta.fullExchangeName || meta.exchangeName || ""),
    currency: String(meta.currency || ""),
    regularMarketTime: finite(meta.regularMarketTime),
    market: {
      regularMarketPrice: finite(meta.regularMarketPrice),
      fiftyTwoWeekHigh: finite(meta.fiftyTwoWeekHigh),
      fiftyTwoWeekLow: finite(meta.fiftyTwoWeekLow),
      regularMarketDayHigh: finite(meta.regularMarketDayHigh),
      regularMarketDayLow: finite(meta.regularMarketDayLow),
      regularMarketVolume: finite(meta.regularMarketVolume),
      previousClose: finite(meta.chartPreviousClose),
    },
    source: identitySource(resolvedAnnotation, curated, description),
  };
}

function displayNameForIdentity(
  meta: Record<string, unknown>,
  annotation: PerpAnnotation | null,
  curated: Pick<AssetIdentity, "displayName" | "description" | "instrumentType"> | undefined,
  symbol: string,
): string {
  const instrumentType = String(meta.instrumentType || curated?.instrumentType || "").toUpperCase();
  const yahooName = String(meta.longName || meta.shortName || "").trim();
  if (instrumentType !== "FUTURE") return yahooName || annotation?.displayName || curated?.displayName || symbol;
  const undatedFuturesName = yahooName.replace(/\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2,4}$/i, "").trim();
  return curated?.displayName || undatedFuturesName || annotation?.displayName || symbol;
}

async function fetchYahooMetadata(yahooSymbol: string, fetcher: typeof fetch): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`);
    url.searchParams.set("range", "1d");
    url.searchParams.set("interval", "1d");
    const response = await fetcher(url, { headers: yahooHeaders(), signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return null;
    const payload = await response.json();
    const meta = payload?.chart?.result?.[0]?.meta;
    return meta && typeof meta === "object" ? meta : null;
  } catch { return null; }
}

function identitySource(
  annotation: PerpAnnotation | null,
  curated: Pick<AssetIdentity, "displayName" | "description" | "instrumentType"> | undefined,
  description: string,
): AssetIdentity["source"] {
  if (annotation) return "hyperliquid+yahoo";
  if (curated) return "curated";
  return description ? "yahoo+wikipedia" : "yahoo";
}

async function fetchPerpAnnotation(asset: string, fetcher: typeof fetch): Promise<PerpAnnotation | null> {
  if (!asset.toLowerCase().startsWith("xyz:")) return null;
  try {
    const response = await fetcher("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "perpAnnotation", coin: asset }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || typeof payload !== "object") return null;
    const description = String(payload.description ?? "").trim();
    const displayName = String(payload.displayName ?? "").trim();
    const category = String(payload.category ?? "").trim().toLowerCase();
    const keywords = Array.isArray(payload.keywords)
      ? payload.keywords.map((keyword: unknown) => String(keyword).trim().toLowerCase()).filter(Boolean)
      : [];
    return description || displayName || category || keywords.length
      ? { category, displayName, description, keywords }
      : null;
  } catch { return null; }
}

function annotatedIdentity(
  symbol: string,
  annotation?: PerpAnnotation | null,
  curated?: Pick<AssetIdentity, "displayName" | "description" | "instrumentType">,
): AssetIdentity {
  const fallback = curatedIdentity(symbol, curated);
  if (!annotation) return fallback;
  return {
    ...fallback,
    displayName: annotation.displayName || fallback.displayName,
    description: annotation.description || fallback.description,
    category: annotation.category,
    keywords: annotation.keywords,
    source: "hyperliquid",
  };
}

function curatedIdentity(symbol: string, curated?: Pick<AssetIdentity, "displayName" | "description" | "instrumentType">): AssetIdentity {
  return {
    symbol,
    yahooSymbol: yahooSymbolForAsset(symbol),
    displayName: curated?.displayName || symbol,
    description: curated?.description || "",
    instrumentType: curated?.instrumentType || "",
    category: "",
    keywords: [],
    exchange: "",
    currency: "",
    regularMarketTime: null,
    market: {},
    source: "curated",
  };
}

async function fetchWikipediaDescription(displayName: string, fetcher: typeof fetch): Promise<string> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("titles", displayName);
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  try {
    const response = await fetcher(url, { headers: { "user-agent": "HYPERDATA/1.0" }, signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return "";
    const payload = await response.json();
    const page = Object.values(payload?.query?.pages ?? {})[0] as { extract?: unknown; missing?: unknown } | undefined;
    if (page && page.missing === undefined) return String(page.extract || "");
    return await fetchWikipediaSearchDescription(displayName, fetcher);
  } catch { return ""; }
}

async function fetchWikipediaSearchDescription(displayName: string, fetcher: typeof fetch): Promise<string> {
  const search = new URL("https://en.wikipedia.org/w/api.php");
  search.searchParams.set("action", "query");
  search.searchParams.set("generator", "search");
  search.searchParams.set("gsrsearch", `intitle:${displayName}`);
  search.searchParams.set("gsrlimit", "1");
  search.searchParams.set("prop", "extracts");
  search.searchParams.set("exintro", "1");
  search.searchParams.set("explaintext", "1");
  search.searchParams.set("format", "json");
  search.searchParams.set("origin", "*");
  try {
    const response = await fetcher(search, { headers: { "user-agent": "HYPERDATA/1.0" }, signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return "";
    const payload = await response.json();
    const page = Object.values(payload?.query?.pages ?? {})[0] as { extract?: unknown } | undefined;
    return String(page?.extract || "");
  } catch { return ""; }
}

export function yahooHeaders(): HeadersInit {
  return { "accept": "application/json", "user-agent": "Mozilla/5.0 (compatible; HYPERDATA/1.0)" };
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
