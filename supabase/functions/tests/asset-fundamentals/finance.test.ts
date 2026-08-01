import { assertEquals } from "@std/assert";
import { fetchYahooFundamentals } from "../../asset-fundamentals/finance.ts";

Deno.test("Yahoo timeseries data becomes latest metrics and aligned quarterly rows", async () => {
  const identity = { symbol: "ORCL", yahooSymbol: "ORCL", displayName: "Oracle Corporation", description: "", instrumentType: "EQUITY", exchange: "NYSE", currency: "USD", regularMarketTime: 1_785_528_246, market: { regularMarketPrice: 130, fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 100, regularMarketVolume: 20_000_000 }, source: "yahoo" as const };
  const series = (type: string, values: Array<[string, number]>) => ({ meta: { type: [type] }, [type]: values.map(([asOfDate, raw]) => ({ asOfDate, currencyCode: "USD", reportedValue: { raw } })) });
  const fetcher = async () => Response.json({ timeseries: { result: [
    series("quarterlyTotalRevenue", [["2025-06-30", 80], ["2026-03-31", 100], ["2026-06-30", 120]]),
    series("quarterlyGrossProfit", [["2026-06-30", 72]]),
    series("quarterlyOperatingIncome", [["2026-06-30", 30]]),
    series("quarterlyNetIncome", [["2026-06-30", 24]]),
    series("quarterlyDilutedEPS", [["2026-06-30", 1.2]]),
    series("quarterlyFreeCashFlow", [["2026-06-30", 18]]),
    series("trailingPeRatio", [["2026-07-31", 25]]),
  ] } });
  const data = await fetchYahooFundamentals(identity, fetcher as typeof fetch, Date.parse("2026-08-01T00:00:00Z"));
  assertEquals(data.available, true);
  assertEquals(data.quarters[0], { date: "2026-06-30", revenue: 120, grossProfit: 72, operatingIncome: 30, netIncome: 24, dilutedEps: 1.2, freeCashFlow: 18 });
  assertEquals(data.metrics.find((metric) => metric.label === "GROSS MARGIN")?.value, 0.6);
  assertEquals(data.metrics.find((metric) => metric.label === "REVENUE GROWTH Y/Y")?.value, 0.5);
});
