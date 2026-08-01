import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolveAssetIdentity, yahooSymbolForAsset } from "../../_shared/asset-identity.ts";

Deno.test("Yahoo chart metadata and Wikipedia lead resolve a company identity", async () => {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("query1.finance.yahoo.com")) return Response.json({ chart: { result: [{ meta: {
      longName: "Oracle Corporation", instrumentType: "EQUITY", fullExchangeName: "NYSE", currency: "USD",
      regularMarketTime: 100, regularMarketPrice: 130,
    } }] } });
    return Response.json({ query: { pages: { "22591": { extract: "Oracle is a technology company." } } } });
  };
  const identity = await resolveAssetIdentity("xyz:ORCL", { fetcher: fetcher as typeof fetch });
  assertEquals(identity.displayName, "Oracle Corporation");
  assertEquals(identity.description, "Oracle is a technology company.");
  assertEquals(identity.source, "yahoo+wikipedia");
  assertEquals(identity.market.regularMarketPrice, 130);
  assertEquals(calls.length, 2);
});

Deno.test("curated non-company assets resolve without a network request", async () => {
  let calls = 0;
  const identity = await resolveAssetIdentity("xyz:DRAM", { fetcher: (() => { calls += 1; throw new Error("unexpected"); }) as typeof fetch });
  assertEquals(identity.displayName, "DRAM");
  assertStringIncludes(identity.description, "dynamic random-access memory");
  assertEquals(identity.yahooSymbol, null);
  assertEquals(calls, 0);
});

Deno.test("Yahoo ticker overrides cover Hyperliquid market aliases", () => {
  assertEquals(yahooSymbolForAsset("xyz:XYZ100"), "^NDX");
  assertEquals(yahooSymbolForAsset("xyz:SOFTBANK"), "9984.T");
  assertEquals(yahooSymbolForAsset("xyz:ORCL"), "ORCL");
});
