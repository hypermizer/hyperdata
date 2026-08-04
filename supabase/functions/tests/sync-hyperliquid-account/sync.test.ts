import { assertEquals, assertRejects } from "@std/assert";
import {
  fetchTimeWindow,
  normalizeFill,
  normalizeFunding,
  normalizeLedger,
  normalizePosition,
} from "../../sync-hyperliquid-account/sync.ts";

const userId = "00000000-0000-0000-0000-000000000081";
const address = "0x003b9e3e0cfd28ba45a3723e393c5443c92792ac";

Deno.test("normalizes fill identifiers as strings without losing u64 precision", () => {
  const fill = normalizeFill(userId, address, {
    coin: "xyz:DRAM", px: "51.492", sz: "100", side: "A", time: 1785863580000,
    startPosition: "100", dir: "Close Long", closedPnl: "2.5", hash: "0xabc",
    oid: 18446744073709551615n.toString(), crossed: true, fee: "0.1", tid: 999999999999999999n.toString(),
    feeToken: "USDC", twapId: null,
  });
  assertEquals(fill.trade_id, "999999999999999999");
  assertEquals(fill.order_id, "18446744073709551615");
  assertEquals(fill.side, "sell");
  assertEquals(fill.price, "51.492");
  assertEquals(fill.occurred_at, "2026-08-04T17:13:00.000Z");
});

Deno.test("normalizes funding and ledger events to deterministic keys", async () => {
  const funding = await normalizeFunding(userId, address, {
    time: 1000, hash: "0xf", delta: { type: "funding", coin: "xyz:DRAM", fundingRate: "0.0001", szi: "2", usdc: "-0.02", nSamples: 1 },
  });
  const ledger = await normalizeLedger(userId, address, {
    time: 2000, hash: "0xl", delta: { type: "send", amount: "4", destination: "0x1" },
  });
  assertEquals(funding.event_key, "0xf:1000:xyz:DRAM");
  assertEquals(ledger.event_type, "send");
  assertEquals(ledger.event_key, "0xl:2000:send");
});

Deno.test("normalizes positions with canonical dex-prefixed assets", () => {
  const position = normalizePosition(userId, address, "xyz", 3000, { position: {
    coin: "DRAM", szi: "-100", entryPx: "51", positionValue: "5100", unrealizedPnl: "12",
    marginUsed: "204", liquidationPx: "70", leverage: { type: "cross", value: 25, rawUsd: "0" },
  } });
  assertEquals(position.asset, "xyz:DRAM");
  assertEquals(position.signed_size, "-100");
  assertEquals(position.leverage, 25);
});

Deno.test("time-window pagination overlaps the cursor and advances through full pages", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fetchPage = async (body: Record<string, unknown>) => {
    calls.push(body);
    const start = Number(body.startTime);
    return start < 3000
      ? Array.from({ length: 2000 }, (_, index) => ({ time: 2000 + index % 1000, tid: String(index) }))
      : [{ time: 4000, tid: "last" }];
  };
  const result = await fetchTimeWindow("userFillsByTime", address, 2500, 5000, fetchPage);
  assertEquals(calls[0].startTime, 0);
  assertEquals(calls[1].startTime, 3000);
  assertEquals(result.cursorMs, 4000);
  assertEquals(result.items.length, 2001);
});

Deno.test("time-window pagination fails closed if a full page cannot advance", async () => {
  await assertRejects(
    () => fetchTimeWindow("userFillsByTime", address, null, 5000, async () => Array.from({ length: 2000 }, () => ({ time: 0 }))),
    Error,
    "pagination did not advance",
  );
});
