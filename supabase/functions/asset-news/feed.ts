export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

const SPECIAL_QUERIES: Record<string, string> = {
  BRENTOIL: '"Brent crude oil" price OPEC supply demand',
  COPPER: '"copper price" futures supply demand mining',
  DRAM: '"DRAM memory" price supply demand shortage Samsung Micron',
  EUR: 'euro EURUSD ECB rates currency',
  GBP: 'sterling GBPUSD "Bank of England" rates currency',
  GOLD: '"gold price" futures rates inflation central banks',
  JP225: 'Nikkei "Japan stocks" market futures',
  JPY: 'yen USDJPY "Bank of Japan" rates currency',
  KR200: 'KOSPI "South Korea stocks" market futures',
  NATGAS: '"natural gas price" futures supply demand storage',
  PALLADIUM: '"palladium price" futures supply demand',
  PLATINUM: '"platinum price" futures supply demand',
  SILVER: '"silver price" futures rates supply demand',
  SMSN: '"Samsung Electronics stock"',
  SP500: '"S&P 500" stocks market futures',
  SKHX: '"SK Hynix stock"',
  SKHY: '"SK Hynix stock"',
  SOFTBANK: '"SoftBank stock"',
  HYUNDAI: '"Hyundai Motor stock"',
  KIOXIA: '"Kioxia stock"',
  GIGADEV: '"GigaDevice stock"',
  XYZ100: '"Nasdaq 100" stocks market futures',
};

export function buildNewsQuery(asset: string): string {
  const symbol = asset.replace(/^xyz:/i, "").toUpperCase();
  return SPECIAL_QUERIES[symbol] ?? `"${symbol} stock"`;
}

export function parseNewsFeed(xml: string, limit = 20): NewsItem[] {
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const source = field(block, "source") || field(block, "News:Source") || "Unknown";
    let title = field(block, "title");
    const url = normalizeNewsUrl(field(block, "link"));
    const publishedAt = new Date(field(block, "pubDate"));
    if (title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    if (!title || !isHttpUrl(url) || Number.isNaN(publishedAt.getTime()) || seen.has(url)) continue;
    seen.add(url);
    items.push({ title, url, source, publishedAt: publishedAt.toISOString() });
    if (items.length >= limit) break;
  }
  return items;
}

function normalizeNewsUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const publisherUrl = parsed.hostname.endsWith("bing.com") ? parsed.searchParams.get("url") : null;
    if (publisherUrl && isHttpUrl(publisherUrl)) return publisherUrl;
    return parsed.href;
  } catch {
    return "";
  }
}

function field(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
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
