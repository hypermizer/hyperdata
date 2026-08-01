import type { AssetIdentity } from "../_shared/asset-identity.ts";
import { yahooHeaders } from "../_shared/asset-identity.ts";

export interface FinancialMetric { label: string; value: number; format: "currency" | "number" | "ratio" | "percent"; asOfDate: string; }
export interface QuarterRow { date: string; revenue?: number; grossProfit?: number; operatingIncome?: number; netIncome?: number; dilutedEps?: number; freeCashFlow?: number; }
export interface AssetFundamentals { identity: AssetIdentity; currency: string; updatedAt: string | null; available: boolean; metrics: FinancialMetric[]; quarters: QuarterRow[]; }

const SERIES = [
  "trailingMarketCap", "trailingPeRatio", "trailingForwardPeRatio",
  "quarterlyTotalRevenue", "quarterlyGrossProfit", "quarterlyOperatingIncome", "quarterlyNetIncome", "quarterlyDilutedEPS",
  "quarterlyEBITDA", "quarterlyOperatingCashFlow", "quarterlyFreeCashFlow", "quarterlyCapitalExpenditure",
  "quarterlyTotalAssets", "quarterlyTotalDebt", "quarterlyStockholdersEquity", "quarterlyCashCashEquivalentsAndShortTermInvestments",
];

const QUARTER_KEYS: Record<string, keyof QuarterRow> = {
  quarterlyTotalRevenue: "revenue", quarterlyGrossProfit: "grossProfit", quarterlyOperatingIncome: "operatingIncome",
  quarterlyNetIncome: "netIncome", quarterlyDilutedEPS: "dilutedEps", quarterlyFreeCashFlow: "freeCashFlow",
};

export async function fetchYahooFundamentals(identity: AssetIdentity, fetcher: typeof fetch = fetch, now = Date.now()): Promise<AssetFundamentals> {
  if (!identity.yahooSymbol) return empty(identity);
  const end = Math.floor(now / 1000) + 86_400;
  const start = end - (3 * 366 * 86_400);
  const url = new URL(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(identity.yahooSymbol)}`);
  url.searchParams.set("symbol", identity.yahooSymbol);
  url.searchParams.set("type", SERIES.join(","));
  url.searchParams.set("period1", String(start));
  url.searchParams.set("period2", String(end));
  const response = await fetcher(url, { headers: yahooHeaders(), signal: AbortSignal.timeout(3_500) });
  if (!response.ok) return empty(identity);
  const payload = await response.json();
  const results = Array.isArray(payload?.timeseries?.result) ? payload.timeseries.result : [];
  if (!results.length) return empty(identity);
  const byType = new Map<string, Array<{ asOfDate?: string; reportedValue?: { raw?: number }; currencyCode?: string }>>();
  for (const result of results) {
    const type = String(result?.meta?.type?.[0] || "");
    if (type && Array.isArray(result[type])) byType.set(type, [...result[type]].sort((a, b) => String(a?.asOfDate || "").localeCompare(String(b?.asOfDate || ""))));
  }
  const latest = (type: string) => byType.get(type)?.filter((item) => Number.isFinite(Number(item?.reportedValue?.raw))).at(-1);
  const raw = (type: string) => Number(latest(type)?.reportedValue?.raw);
  const date = (type: string) => String(latest(type)?.asOfDate || "");
  const metrics: FinancialMetric[] = [];
  add(metrics, "MARKET CAP", raw("trailingMarketCap"), "currency", date("trailingMarketCap"));
  add(metrics, "TRAILING P/E", raw("trailingPeRatio"), "ratio", date("trailingPeRatio"));
  add(metrics, "FORWARD P/E", raw("trailingForwardPeRatio"), "ratio", date("trailingForwardPeRatio"));
  add(metrics, "QUARTERLY REVENUE", raw("quarterlyTotalRevenue"), "currency", date("quarterlyTotalRevenue"));
  add(metrics, "GROSS PROFIT", raw("quarterlyGrossProfit"), "currency", date("quarterlyGrossProfit"));
  add(metrics, "EBITDA", raw("quarterlyEBITDA"), "currency", date("quarterlyEBITDA"));
  add(metrics, "OPERATING INCOME", raw("quarterlyOperatingIncome"), "currency", date("quarterlyOperatingIncome"));
  add(metrics, "NET INCOME", raw("quarterlyNetIncome"), "currency", date("quarterlyNetIncome"));
  add(metrics, "DILUTED EPS", raw("quarterlyDilutedEPS"), "number", date("quarterlyDilutedEPS"));
  add(metrics, "OPERATING CASH FLOW", raw("quarterlyOperatingCashFlow"), "currency", date("quarterlyOperatingCashFlow"));
  add(metrics, "FREE CASH FLOW", raw("quarterlyFreeCashFlow"), "currency", date("quarterlyFreeCashFlow"));
  add(metrics, "CAPITAL EXPENDITURE", raw("quarterlyCapitalExpenditure"), "currency", date("quarterlyCapitalExpenditure"));
  add(metrics, "CASH + SHORT-TERM INVESTMENTS", raw("quarterlyCashCashEquivalentsAndShortTermInvestments"), "currency", date("quarterlyCashCashEquivalentsAndShortTermInvestments"));
  add(metrics, "TOTAL ASSETS", raw("quarterlyTotalAssets"), "currency", date("quarterlyTotalAssets"));
  add(metrics, "TOTAL DEBT", raw("quarterlyTotalDebt"), "currency", date("quarterlyTotalDebt"));
  add(metrics, "STOCKHOLDERS' EQUITY", raw("quarterlyStockholdersEquity"), "currency", date("quarterlyStockholdersEquity"));
  add(metrics, "GROSS MARGIN", ratio(raw("quarterlyGrossProfit"), raw("quarterlyTotalRevenue")), "percent", date("quarterlyGrossProfit"));
  add(metrics, "OPERATING MARGIN", ratio(raw("quarterlyOperatingIncome"), raw("quarterlyTotalRevenue")), "percent", date("quarterlyOperatingIncome"));
  add(metrics, "NET MARGIN", ratio(raw("quarterlyNetIncome"), raw("quarterlyTotalRevenue")), "percent", date("quarterlyNetIncome"));
  add(metrics, "FREE CASH FLOW MARGIN", ratio(raw("quarterlyFreeCashFlow"), raw("quarterlyTotalRevenue")), "percent", date("quarterlyFreeCashFlow"));
  add(metrics, "REVENUE GROWTH Y/Y", yearOverYear(byType.get("quarterlyTotalRevenue")), "percent", date("quarterlyTotalRevenue"));
  add(metrics, "DILUTED EPS GROWTH Y/Y", yearOverYear(byType.get("quarterlyDilutedEPS")), "percent", date("quarterlyDilutedEPS"));
  add(metrics, "DEBT / EQUITY", ratio(raw("quarterlyTotalDebt"), raw("quarterlyStockholdersEquity")), "ratio", date("quarterlyTotalDebt"));
  for (const [label, key] of [["PRICE", "regularMarketPrice"], ["52W HIGH", "fiftyTwoWeekHigh"], ["52W LOW", "fiftyTwoWeekLow"], ["DAY VOLUME", "regularMarketVolume"]] as const) {
    add(metrics, label, Number(identity.market[key]), key === "regularMarketVolume" ? "number" : "currency", identity.regularMarketTime ? new Date(identity.regularMarketTime * 1000).toISOString().slice(0, 10) : "");
  }
  const quarters = buildQuarters(byType);
  const currency = String(latest("quarterlyTotalRevenue")?.currencyCode || identity.currency || "");
  const updatedAt = [...metrics.map((metric) => metric.asOfDate), ...quarters.map((quarter) => quarter.date)].filter(Boolean).sort().at(-1) || null;
  return { identity, currency, updatedAt, available: metrics.length > 0 || quarters.length > 0, metrics, quarters };
}

function buildQuarters(byType: Map<string, Array<{ asOfDate?: string; reportedValue?: { raw?: number } }>>): QuarterRow[] {
  const rows = new Map<string, QuarterRow>();
  for (const [type, key] of Object.entries(QUARTER_KEYS)) {
    for (const item of byType.get(type) ?? []) {
      const date = String(item.asOfDate || "");
      const value = Number(item.reportedValue?.raw);
      if (!date || !Number.isFinite(value)) continue;
      const row = rows.get(date) ?? { date };
      row[key] = value as never;
      rows.set(date, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
}

function add(metrics: FinancialMetric[], label: string, value: number, format: FinancialMetric["format"], asOfDate: string) {
  if (Number.isFinite(value)) metrics.push({ label, value, format, asOfDate });
}

function ratio(numerator: number, denominator: number): number {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : Number.NaN;
}

function yearOverYear(series?: Array<{ asOfDate?: string; reportedValue?: { raw?: number } }>): number {
  const values = series?.flatMap((item) => {
    const value = Number(item.reportedValue?.raw);
    const timestamp = Date.parse(String(item.asOfDate || ""));
    return Number.isFinite(value) && Number.isFinite(timestamp) ? [{ value, timestamp }] : [];
  }) ?? [];
  const current = values.at(-1);
  if (!current) return Number.NaN;
  const yearAgo = current.timestamp - 365.25 * 86_400_000;
  const prior = values.slice(0, -1).reduce<{ value: number; timestamp: number } | null>((best, candidate) => (
    !best || Math.abs(candidate.timestamp - yearAgo) < Math.abs(best.timestamp - yearAgo) ? candidate : best
  ), null);
  return prior && Math.abs(prior.timestamp - yearAgo) <= 45 * 86_400_000 && prior.value !== 0
    ? (current.value / prior.value) - 1
    : Number.NaN;
}

function empty(identity: AssetIdentity): AssetFundamentals {
  return { identity, currency: identity.currency, updatedAt: null, available: false, metrics: [], quarters: [] };
}
