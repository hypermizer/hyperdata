import { bareAssetSymbol, type AssetIdentity } from "../_shared/asset-identity.ts";

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  topic?: string;
  score?: number;
}

const HIGH_INFO = ["earnings", "revenue", "guidance", "forecast", "sec", "filing", "10-k", "10-q", "8-k", "acquisition", "merger", "lawsuit", "regulation", "investigation", "contract", "partnership", "upgrade", "downgrade", "price target", "dividend", "buyback", "offering", "bankruptcy", "shortage", "recall", "approval", "tariff", "sanction"];
const NOISE = ["should you buy", "is it too late", "prediction", "top stocks", "best stocks", "stock of the day", "why this stock", "why stock", "trending stock", "investor attention", "before betting", "could be the next", "millionaire maker", "motley fool"];
const QUALITY_SOURCES: Record<string, number> = {
  reuters: 24, bloomberg: 22, "wall street journal": 21, "wsj.com": 21, wsj: 21, "financial times": 20, "sec.gov": 22,
  "associated press": 18, ap: 18, cnbc: 16, barrons: 16, "the information": 17, nikkei: 17,
  "investor relations": 18, businesswire: 11, globenewswire: 10, marketwatch: 10, yahoo: 8,
};
const TITLE_STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "co", "company", "corporation", "for", "from", "group", "has", "holdings", "in", "inc", "is", "it", "limited", "ltd", "of", "on", "or", "plc", "that", "the", "this", "to", "with"]);

export function buildNewsQuery(asset: string): string {
  return buildNewsQueries(asset)[0];
}

export function buildNewsQueries(asset: string, identity: AssetIdentity | string = ""): string[] {
  const symbol = bareAssetSymbol(asset);
  const data = typeof identity === "string" ? { displayName: identity, category: "", keywords: [] as string[], instrumentType: "" } : identity;
  const displayName = String(data.displayName || "").trim();
  const meaningfulKeywords = (data.keywords ?? []).filter((keyword) => !["ai", "tech", "stock", "stocks"].includes(keyword.toLowerCase())).slice(0, 2);
  const exactName = displayName && displayName.toUpperCase() !== symbol ? displayName : symbol;
  const subject = `"${exactName}"`;
  const contextSubject = exactName === symbol && meaningfulKeywords.length
    ? [subject, ...meaningfulKeywords].join(" ")
    : subject;
  const category = String(data.category || "").toLowerCase();
  const isEtf = String(data.instrumentType || "").toUpperCase() === "ETF" || (data.keywords ?? []).some((keyword) => keyword.toLowerCase() === "etf");
  if (isEtf) return uniqueQueries([
    `${subject} fund flows`, `${subject} holdings`, `${subject} ETF price`, `${contextSubject} sector outlook`, `${subject} rebalance`, `${subject} analyst`,
  ]);
  if (["commodity", "commodities"].includes(category)) return uniqueQueries([
    `${subject} price`, `${subject} supply demand`, `${subject} inventory`, `${subject} futures`, `${subject} geopolitical`, `${subject} forecast`,
  ]);
  if (["fx", "forex", "currency"].includes(category)) return uniqueQueries([
    `${subject} exchange rate`, `${subject} central bank`, `${subject} interest rates`, `${subject} inflation`, `${subject} economy`, `${subject} forecast`,
  ]);
  if (["index", "indices"].includes(category)) return uniqueQueries([
    `${subject} market`, `${subject} earnings`, `${subject} interest rates`, `${subject} futures`, `${subject} constituents`, `${subject} outlook`,
  ]);
  if (["preipo", "pre-ipo"].includes(category)) return uniqueQueries([
    `${subject} IPO`, `${subject} valuation`, `${subject} funding`, `${subject} filing`, `${subject} listing`, `${subject} company news`,
  ]);
  return uniqueQueries([
    `${contextSubject} stock`, `${subject} earnings`, `${subject} guidance`, `${subject} SEC filing`, `${subject} analyst`, `${subject} acquisition`, `${subject} contract`, `${subject} regulation lawsuit`,
  ]);
}

export function buildNewsSearchUrl(query: string): URL {
  const url = new URL("https://www.bing.com/news/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  url.searchParams.set("qft", 'interval="30"');
  url.searchParams.set("sortbydate", "1");
  return url;
}

export function parseNewsFeed(xml: string, limit = 25): NewsItem[] {
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const source = field(block, "source") || field(block, "News:Source") || "Unknown";
    let title = field(block, "title");
    const url = normalizeNewsUrl(field(block, "link"));
    const publishedAt = new Date(field(block, "pubDate"));
    if (title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const canonical = canonicalUrl(url);
    if (!title || !canonical || Number.isNaN(publishedAt.getTime()) || seen.has(canonical)) continue;
    seen.add(canonical);
    items.push({ title, url: canonical, source, publishedAt: publishedAt.toISOString() });
    if (items.length >= limit) break;
  }
  return items;
}

export function rankAndDeduplicateNews(items: NewsItem[], identity: AssetIdentity, now = Date.now(), limit = 25): NewsItem[] {
  const symbol = identity.symbol.toLowerCase();
  const identityTokens = tokens(`${identity.displayName} ${symbol} ${identity.keywords.join(" ")}`)
    .filter((token) => token.length > 2 && !["stock", "stocks", "share", "shares", "etf", "market", "markets", "tech", "technology"].includes(token));
  const scored = items.flatMap((item) => {
    const title = item.title.toLowerCase();
    const titleTokens = tokens(title);
    const relevantTokens = identityTokens.filter((token) => titleTokens.includes(token)).length;
    const exactSymbol = symbol.length > 2 && new RegExp(`(^|\\W)${escapeRegex(symbol)}($|\\W)`, "i").test(item.title);
    if (!exactSymbol && relevantTokens === 0) return [];
    const publishedTime = new Date(item.publishedAt).getTime();
    if (publishedTime > now + 6 * 3_600_000) return [];
    const ageHours = Math.max(0, (now - publishedTime) / 3_600_000);
    if (ageHours > 30 * 24) return [];
    const informationHits = HIGH_INFO.filter((term) => title.includes(term)).length;
    const noiseText = `${title} ${item.source.toLowerCase()}`;
    const noiseHits = NOISE.filter((term) => noiseText.includes(term)).length;
    const score = Math.round(
      Math.max(0, 48 - Math.log2(1 + ageHours) * 9)
      + Math.min(28, relevantTokens * 6 + (exactSymbol ? 8 : 0))
      + Math.min(24, informationHits * 8)
      + sourceQuality(item.source)
      - noiseHits * 24,
    );
    return score > 0 ? [{ ...item, score, topic: classifyTopic(title) }] : [];
  }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.publishedAt.localeCompare(a.publishedAt));

  const selected: NewsItem[] = [];
  for (const item of scored) {
    const itemTokens = tokens(item.title);
    const duplicate = selected.some((existing) => existing.url === item.url || titleSimilarity(itemTokens, tokens(existing.title)) >= 0.72);
    if (!duplicate) selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function uniqueQueries(queries: string[]): string[] {
  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function classifyTopic(title: string): string {
  if (/earnings|revenue|profit|margin|guidance|forecast/.test(title)) return "EARNINGS";
  if (/sec|filing|10-k|10-q|8-k|offering|buyback|dividend/.test(title)) return "FILING / CAPITAL";
  if (/acquisition|merger|contract|partnership|deal/.test(title)) return "CORPORATE ACTION";
  if (/lawsuit|regulat|investigat|approval|tariff|sanction/.test(title)) return "POLICY / LEGAL";
  if (/upgrade|downgrade|price target|analyst/.test(title)) return "ANALYST";
  if (/supply|demand|shortage|inventory|opec|geopolit/.test(title)) return "SUPPLY / MACRO";
  return "MARKET";
}

function sourceQuality(source: string): number {
  const normalized = source.toLowerCase();
  for (const [name, score] of Object.entries(QUALITY_SOURCES)) {
    if (name.length <= 3 ? normalized === name || normalized.startsWith(`${name} `) : normalized.includes(name)) return score;
  }
  return 4;
}

function titleSimilarity(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = Math.min(left.size, right.size) ? intersection / Math.min(left.size, right.size) : 0;
  return Math.max(jaccard, containment * 0.9);
}

function tokens(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((token) => token && !TITLE_STOP_WORDS.has(token));
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    [...url.searchParams.keys()].forEach((key) => {
      if (/^(utm_|fbclid|gclid|mc_|guccounter|guce_referrer|ocid|cmpid|ncid|soc_src|soc_trk)/i.test(key)) url.searchParams.delete(key);
    });
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.href;
  } catch { return ""; }
}

function normalizeNewsUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const publisherUrl = parsed.hostname.endsWith("bing.com") ? parsed.searchParams.get("url") : null;
    if (publisherUrl && isHttpUrl(publisherUrl)) return publisherUrl;
    return parsed.href;
  } catch { return ""; }
}

function field(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\/${name}>`, "i"));
  return decodeXml(match?.[1]?.replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() ?? "");
}

function decodeXml(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? _match;
  });
}

function isHttpUrl(value: string): boolean {
  try { return /^https?:$/.test(new URL(value).protocol); }
  catch { return false; }
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
