export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

const SPECIAL_QUERIES: Record<string, string> = {
  BRENTOIL: '"Brent crude oil" (price OR futures OR OPEC OR supply OR demand)',
  COPPER: '"copper price" (futures OR supply OR demand OR mining)',
  DRAM: '"DRAM memory" (price OR supply OR demand OR shortage OR Samsung OR Micron OR "SK Hynix")',
  EUR: '(euro OR EURUSD) (ECB OR rates OR currency)',
  GBP: '(sterling OR GBPUSD) ("Bank of England" OR rates OR currency)',
  GOLD: '"gold price" (futures OR rates OR inflation OR central banks)',
  JP225: '(Nikkei OR "Japan stocks") (market OR futures)',
  JPY: '(yen OR USDJPY) ("Bank of Japan" OR rates OR currency)',
  KR200: '(KOSPI OR "South Korea stocks") (market OR futures)',
  NATGAS: '"natural gas price" (futures OR supply OR demand OR storage)',
  PALLADIUM: '"palladium price" (futures OR supply OR demand)',
  PLATINUM: '"platinum price" (futures OR supply OR demand)',
  SILVER: '"silver price" (futures OR rates OR supply OR demand)',
  SP500: '("S&P 500" OR SPX) (stocks OR market OR futures)',
  XYZ100: '("Nasdaq 100" OR NDX) (stocks OR market OR futures)',
};

export function buildNewsQuery(asset: string): string {
  const symbol = asset.replace(/^xyz:/i, "").toUpperCase();
  const topic = SPECIAL_QUERIES[symbol] ?? `("${symbol}" OR "${symbol} stock") (stock OR shares OR price OR earnings OR guidance OR SEC OR acquisition)`;
  return `${topic} when:30d`;
}

export function parseNewsFeed(xml: string, limit = 20): NewsItem[] {
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const source = field(block, "source") || "Unknown";
    let title = field(block, "title");
    const url = field(block, "link");
    const publishedAt = new Date(field(block, "pubDate"));
    if (title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    if (!title || !isHttpUrl(url) || Number.isNaN(publishedAt.getTime()) || seen.has(url)) continue;
    seen.add(url);
    items.push({ title, url, source, publishedAt: publishedAt.toISOString() });
    if (items.length >= limit) break;
  }
  return items;
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
