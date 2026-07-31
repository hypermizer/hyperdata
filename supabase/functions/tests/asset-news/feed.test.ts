import { assertEquals } from "@std/assert";
import { buildNewsQuery, parseNewsFeed } from "../../asset-news/feed.ts";

Deno.test("company and market assets produce price-relevant news queries", () => {
  assertEquals(buildNewsQuery("xyz:ORCL").includes("ORCL"), true);
  assertEquals(buildNewsQuery("xyz:ORCL").includes("earnings"), true);
  assertEquals(buildNewsQuery("xyz:DRAM").includes("DRAM memory"), true);
  assertEquals(buildNewsQuery("xyz:GOLD").includes("gold price"), true);
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
