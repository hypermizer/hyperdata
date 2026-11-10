import { assertEquals, assertThrows } from "@std/assert";
import { archiveMarkUrl, parseArchiveMarks } from "../archive-mark-data.ts";
Deno.test("archive marks preserve market identity, raw timestamps, decimals, and opaque pagination", () => {
  const url = archiveMarkUrl("xyz:ICE", 1000, 3000, "opaque+/=");
  assertEquals(url.searchParams.has("interval"), false);
  assertEquals(url.searchParams.get("cursor"), "opaque+/=");
  const result = parseArchiveMarks(
    {
      success: true,
      data: [{
        timestamp: "1970-01-01T00:00:02.123Z",
        mark_price: "0.00000123456789",
        oracle_price: "99",
      }],
      meta: { symbol: "xyz:ICE", has_more: true, next_cursor: "next" },
    },
    "xyz:ICE",
    1000,
    3000,
  );
  assertEquals(result, {
    points: [{ time: 2123, price: "0.00000123456789" }],
    cursor: "next",
  });
});
Deno.test("archive marks reject other assets, oracle-only rows, future observations, and missing cursors", () => {
  const good = {
    success: true,
    data: [{ timestamp: "1970-01-01T00:00:02Z", mark_price: "10" }],
    meta: { symbol: "BTC", has_more: false },
  };
  assertThrows(() =>
    parseArchiveMarks(
      { ...good, meta: { ...good.meta, symbol: "ETH" } },
      "BTC",
      1000,
      3000,
    )
  );
  assertThrows(() =>
    parseArchiveMarks(
      {
        ...good,
        data: [{ timestamp: "1970-01-01T00:00:02Z", oracle_price: "10" }],
      },
      "BTC",
      1000,
      3000,
    )
  );
  assertThrows(() => parseArchiveMarks(good, "BTC", 1000, 1500));
  assertThrows(() =>
    parseArchiveMarks(
      { ...good, meta: { ...good.meta, has_more: true } },
      "BTC",
      1000,
      3000,
    )
  );
  assertThrows(() => archiveMarkUrl("BTC/../../auth", 1000, 3000));
});
