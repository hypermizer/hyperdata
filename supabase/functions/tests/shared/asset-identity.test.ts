import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolveAssetIdentity, yahooSymbolForAsset } from "../../_shared/asset-identity.ts";

Deno.test("Yahoo chart metadata and Wikipedia lead resolve a company identity", async () => {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.hyperliquid.xyz")) return Response.json({
      category: "stocks", displayName: "ORCL", keywords: ["oracle", "cloud"],
      description: "ORCL tracks Oracle Corporation, an enterprise software and cloud infrastructure company.",
    });
    if (url.includes("query1.finance.yahoo.com")) return Response.json({ chart: { result: [{ meta: {
      longName: "Oracle Corporation", instrumentType: "EQUITY", fullExchangeName: "NYSE", currency: "USD",
      regularMarketTime: 100, regularMarketPrice: 130,
    } }] } });
    return Response.json({ query: { pages: { "22591": { extract: "Oracle is a technology company." } } } });
  };
  const identity = await resolveAssetIdentity("xyz:ORCL", { fetcher: fetcher as typeof fetch });
  assertEquals(identity.displayName, "Oracle Corporation");
  assertEquals(identity.description, "ORCL tracks Oracle Corporation, an enterprise software and cloud infrastructure company.");
  assertEquals(identity.category, "stocks");
  assertEquals(identity.keywords, ["oracle", "cloud"]);
  assertEquals(identity.source, "hyperliquid+yahoo");
  assertEquals(identity.market.regularMarketPrice, 130);
  assertEquals(calls.length, 2);
});

Deno.test("official annotations identify products that ticker-only lookup gets wrong", async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.hyperliquid.xyz")) return Response.json({
      category: "stocks", displayName: "DRAM", keywords: ["etf", "memory"],
      description: "DRAM tracks the value of 1 share of Roundhill Memory ETF (DRAM).",
    });
    return Response.json({ chart: { result: [{ meta: { longName: "Roundhill Memory ETF", instrumentType: "ETF", currency: "USD" } }] } });
  };
  const identity = await resolveAssetIdentity("xyz:DRAM", { fetcher: fetcher as typeof fetch });
  assertEquals(identity.displayName, "Roundhill Memory ETF");
  assertStringIncludes(identity.description, "Roundhill Memory ETF");
  assertEquals(identity.yahooSymbol, "DRAM");
  assertEquals(identity.keywords, ["etf", "memory"]);
});

Deno.test("futures identities remove the dated Yahoo contract suffix", async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.hyperliquid.xyz")) return Response.json({
      category: "commodities", displayName: "WTIOIL", keywords: ["crude", "CL"],
      description: "CL tracks one barrel of West Texas Intermediate crude oil.",
    });
    return Response.json({ chart: { result: [{ meta: { shortName: "Crude Oil Sep 26", instrumentType: "FUTURE", currency: "USD" } }] } });
  };
  const identity = await resolveAssetIdentity("xyz:CL", { fetcher: fetcher as typeof fetch });
  assertEquals(identity.displayName, "Crude Oil");
  assertEquals(identity.description, "CL tracks one barrel of West Texas Intermediate crude oil.");
});

Deno.test("Yahoo ticker overrides cover Hyperliquid market aliases", () => {
  assertEquals(yahooSymbolForAsset("xyz:XYZ100"), "^NDX");
  assertEquals(yahooSymbolForAsset("xyz:SOFTBANK"), "9984.T");
  assertEquals(yahooSymbolForAsset("xyz:ORCL"), "ORCL");
});
