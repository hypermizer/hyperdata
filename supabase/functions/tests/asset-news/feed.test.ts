import { assertEquals } from "@std/assert";
import { buildNewsQueries, buildNewsQuery, parseNewsFeed, rankAndDeduplicateNews } from "../../asset-news/feed.ts";

Deno.test("company and market assets produce price-relevant news queries", () => {
  assertEquals(buildNewsQuery("xyz:ORCL").includes("ORCL"), true);
  assertEquals(buildNewsQuery("xyz:ORCL").includes("stock"), true);
  assertEquals(buildNewsQuery("xyz:DRAM").includes("DRAM memory"), true);
  assertEquals(buildNewsQuery("xyz:GOLD").includes("gold price"), true);
});

Deno.test("company news searches multiple price-relevant facets", () => {
  const queries = buildNewsQueries("xyz:ORCL", "Oracle Corporation");
  assertEquals(queries.length, 8);
  assertEquals(queries.some((query) => query.includes("earnings")), true);
  assertEquals(queries.some((query) => query.includes("SEC filing")), true);
  assertEquals(queries.some((query) => query.includes("analyst")), true);
});

Deno.test("Google News RSS is decoded, deduplicated, and source suffixes are removed", () => {
  const xml = `<rss><channel>
    <item><title>Oracle &amp; OpenAI expand deal - Reuters</title><link>https://news.google.com/a</link><pubDate>Fri, 31 Jul 2026 12:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
    <item><title>Oracle &amp; OpenAI expand deal - Reuters</title><link>https://news.google.com/a</link><pubDate>Fri, 31 Jul 2026 12:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
  </channel></rss>`;
  assertEquals(parseNewsFeed(xml), [{
    title: "Oracle & OpenAI expand deal",
    url: "https://news.google.com/a",
    source: "Reuters",
    publishedAt: "2026-07-31T12:00:00.000Z",
  }]);
});

Deno.test("news ranking rewards high-information sources and removes near duplicates", () => {
  const identity = { symbol: "ORCL", yahooSymbol: "ORCL", displayName: "Oracle Corporation", description: "", instrumentType: "EQUITY", exchange: "NYSE", currency: "USD", regularMarketTime: null, market: {}, source: "yahoo" as const };
  const items = [
    { title: "Oracle raises earnings guidance after cloud revenue jump", url: "https://reuters.com/a?utm_source=x", source: "Reuters", publishedAt: "2026-07-31T12:00:00.000Z" },
    { title: "Oracle raises earnings guidance after cloud revenue jumps", url: "https://example.com/copy", source: "Blog", publishedAt: "2026-07-31T11:00:00.000Z" },
    { title: "Should you buy Oracle stock today?", url: "https://example.com/noise", source: "Motley Fool", publishedAt: "2026-07-31T13:00:00.000Z" },
  ];
  const ranked = rankAndDeduplicateNews(items, identity, Date.parse("2026-08-01T00:00:00Z"));
  assertEquals(ranked.length, 1);
  assertEquals(ranked[0].source, "Reuters");
  assertEquals(ranked[0].topic, "EARNINGS");
});

Deno.test("Bing News RSS uses publisher sources and direct article links", () => {
  const articleUrl = "https://example.com/oracle-earnings";
  const redirect = `https://www.bing.com/news/apiclick.aspx?url=${encodeURIComponent(articleUrl)}&mkt=en-us`;
  const xml = `<rss><channel><item><title>Oracle earnings rise</title><link>${redirect.replaceAll("&", "&amp;")}</link><pubDate>Fri, 31 Jul 2026 12:00:00 GMT</pubDate><News:Source>Reuters</News:Source></item></channel></rss>`;
  assertEquals(parseNewsFeed(xml), [{
    title: "Oracle earnings rise",
    url: articleUrl,
    source: "Reuters",
    publishedAt: "2026-07-31T12:00:00.000Z",
  }]);
});
