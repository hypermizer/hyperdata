import { assertEquals } from "@std/assert";
import { handlePaperCommand, type PaperCommandDependencies } from "../../paper-command/handler.ts";

const asset = {
  asset: "xyz:ORCL", dex: "xyz", collateralToken: 0, sizeDecimals: 3, maxLeverage: 10,
  marginTableId: 10, onlyIsolated: true, marginMode: "noCross", growthMode: "enabled",
  marginTiers: [{ lowerBound: "0", maxLeverage: 10, maintenanceRate: "0.05", maintenanceDeduction: "0" }],
};
const book = {
  asset: "xyz:ORCL", timestampMs: 1_000,
  bids: [{ price: "99", size: "2", orders: 1 }],
  asks: [{ price: "100", size: "0.5", orders: 1 }, { price: "101", size: "0.5", orders: 1 }],
};

function request(body: unknown, token = "good") {
  return new Request("http://local/paper-command", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: Partial<PaperCommandDependencies> = {}): PaperCommandDependencies {
  return {
    enabled: true,
    authenticate: async (token) => token === "good" ? { id: "user-1", email: "jasonblick@zohomail.com" } : null,
    loadAccount: async () => ({ epochNumber: 1, version: 0, cashBalance: "5000", availableMargin: "5000", currentMargin: "0", trailingVolume: "0", makerFraction: "0", position: null }),
    findCommand: async () => null,
    loadAsset: async () => asset,
    loadMark: async () => ({ markPrice: "100", inputVersion: "mark-v1" }),
    loadBook: async () => ({ book, inputVersion: "book-v1" }),
    loadFeeSchedule: async () => ({ schedule: { volumeTiers: [{ minimumVolume: "0", makerRate: "0.00015", takerRate: "0.00045" }], makerFractionTiers: [] }, inputVersion: "fees-v1" }),
    applyEffects: async (effects) => effects,
    now: () => 2_000,
    ...overrides,
  };
}

const marketBuy = {
  type: "place_order",
  accountId: "account-1",
  epochNumber: 1,
  expectedVersion: 0,
  idempotencyKey: "cmd-1",
  order: {
    asset: "xyz:ORCL", side: "buy", size: "0.75", orderType: "market",
    timeInForce: null, limitPrice: null, leverage: 5, marginMode: "isolated", reduceOnly: false,
  },
};

Deno.test("authenticated market command produces canonical multi-level effects", async () => {
  let applied: unknown;
  const response = await handlePaperCommand(request(marketBuy), dependencies({
    applyEffects: async (effects) => (applied = effects),
  }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.response.status, "filled");
  assertEquals(body.fills.map((fill: { price: string; size: string }) => [fill.price, fill.size]), [["100", "0.5"], ["101", "0.25"]]);
  assertEquals(body.fills.map((fill: { sourceId: string }) => fill.sourceId), ["cmd-1:book-v1:0", "cmd-1:book-v1:1"]);
  assertEquals(body.position, { signedSize: "0.75", entryPrice: "100.33333333333333333333" });
  assertEquals(body.ledger, [{ entry_type: "fee", amount: "-0.0338625", asset: "xyz:ORCL", source_timestamp: "1970-01-01T00:00:01.000Z" }]);
  assertEquals(applied, body);
});

Deno.test("immediate fills use the account's earned volume fee tier", async () => {
  const response = await handlePaperCommand(request({
    ...marketBuy, idempotencyKey: "vip-fee", order: { ...marketBuy.order, size: "0.5" },
  }), dependencies({
    loadAccount: async () => ({
      epochNumber: 1, version: 0, cashBalance: "5000", availableMargin: "5000", currentMargin: "0",
      trailingVolume: "5000000", makerFraction: "0", position: null,
    }),
    loadFeeSchedule: async () => ({
      schedule: {
        volumeTiers: [
          { minimumVolume: "0", makerRate: "0.00015", takerRate: "0.00045" },
          { minimumVolume: "5000000", makerRate: "0.00012", takerRate: "0.0004" },
        ],
        makerFractionTiers: [],
      },
      inputVersion: "fees-vip",
    }),
  }));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).fills[0].fee, "0.02");
});

Deno.test("immediate execution checks margin against filled notional after slippage", async () => {
  let applied = false;
  const response = await handlePaperCommand(request({
    ...marketBuy,
    idempotencyKey: "slippage-margin",
    order: { ...marketBuy.order, size: "1", leverage: 1 },
  }), dependencies({
    loadAccount: async () => ({ epochNumber: 1, version: 0, cashBalance: "5000", availableMargin: "100.25", currentMargin: "0", trailingVolume: "0", makerFraction: "0", position: null }),
    applyEffects: async (effects) => { applied = true; return effects; },
  }));
  assertEquals(response.status, 422);
  assertEquals((await response.json()).error, "insufficient_margin");
  assertEquals(applied, false);
});

Deno.test("immediate execution checks final position margin across tier boundaries", async () => {
  let applied = false;
  const response = await handlePaperCommand(request({
    ...marketBuy,
    idempotencyKey: "tier-crossing-margin",
    order: { ...marketBuy.order, size: "1", leverage: 10 },
  }), dependencies({
    loadAccount: async () => ({
      epochNumber: 1, version: 0, cashBalance: "5000", availableMargin: "20", currentMargin: "10", trailingVolume: "0", makerFraction: "0",
      position: { signedSize: "1", entryPrice: "100" },
    }),
    loadAsset: async () => ({
      ...asset,
      marginTiers: [
        { lowerBound: "0", maxLeverage: 10, maintenanceRate: "0.05", maintenanceDeduction: "0" },
        { lowerBound: "150", maxLeverage: 2, maintenanceRate: "0.1", maintenanceDeduction: "7.5" },
      ],
    }),
    applyEffects: async (effects) => { applied = true; return effects; },
  }));
  assertEquals(response.status, 422);
  assertEquals((await response.json()).error, "insufficient_margin");
  assertEquals(applied, false);
});

Deno.test("pure reduction bypasses expansion margin at a lower command leverage", async () => {
  const response = await handlePaperCommand(request({
    ...marketBuy,
    idempotencyKey: "pure-reduction",
    order: {
      ...marketBuy.order, side: "sell", size: "0.5", leverage: 1, reduceOnly: true,
    },
  }), dependencies({
    loadAccount: async () => ({
      epochNumber: 1, version: 0, cashBalance: "5000", availableMargin: "0", currentMargin: "20",
      trailingVolume: "0", makerFraction: "0", position: { signedSize: "1", entryPrice: "100" },
    }),
  }));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).position.signedSize, "0.5");
});

Deno.test("authorization and ownership happen before any market request", async () => {
  let marketCalls = 0;
  const response = await handlePaperCommand(request(marketBuy, "bad"), dependencies({
    loadAsset: async () => { marketCalls += 1; return asset; },
  }));
  assertEquals(response.status, 401);
  assertEquals(marketCalls, 0);
});

Deno.test("disabled feature rejects before account or market reads", async () => {
  let reads = 0;
  const response = await handlePaperCommand(request(marketBuy), dependencies({
    enabled: false,
    loadAccount: async () => { reads += 1; return null; },
    loadAsset: async () => { reads += 1; return asset; },
  }));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "paper_trading_disabled");
  assertEquals(reads, 0);
});

Deno.test("stored idempotent result bypasses market retrieval", async () => {
  let marketCalls = 0;
  const stored = { response: { status: "filled" }, stored: true };
  const response = await handlePaperCommand(request(marketBuy), dependencies({
    findCommand: async () => stored,
    loadAsset: async () => { marketCalls += 1; return asset; },
  }));
  assertEquals(await response.json(), stored);
  assertEquals(marketCalls, 0);
});

Deno.test("stored idempotent retry wins over a stale expected version", async () => {
  const stored = { response: { status: "filled" }, stored: true };
  const response = await handlePaperCommand(request(marketBuy), dependencies({
    loadAccount: async () => ({ epochNumber: 1, version: 1, cashBalance: "4900", availableMargin: "4800", currentMargin: "0", trailingVolume: "0", makerFraction: "0", position: null }),
    findCommand: async () => stored,
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), stored);
});

Deno.test("nonzero collateral asset rejects without book retrieval", async () => {
  let bookCalls = 0;
  const response = await handlePaperCommand(request(marketBuy), dependencies({
    loadAsset: async () => ({ ...asset, collateralToken: 360 }),
    loadBook: async () => { bookCalls += 1; return { book, inputVersion: "book-v1" }; },
  }));
  assertEquals(response.status, 422);
  assertEquals((await response.json()).error, "unsupported_collateral");
  assertEquals(bookCalls, 0);
});

Deno.test("stale epoch rejects before public market retrieval", async () => {
  let marketCalls = 0;
  const response = await handlePaperCommand(request({ ...marketBuy, epochNumber: 2 }), dependencies({
    loadAsset: async () => { marketCalls += 1; return asset; },
  }));
  assertEquals(response.status, 409);
  assertEquals(marketCalls, 0);
});

Deno.test("valid trigger persists without fetching an execution book", async () => {
  let bookCalls = 0;
  const command = {
    ...marketBuy,
    idempotencyKey: "trigger-1",
    order: { ...marketBuy.order, side: "sell", orderType: "stop_market", triggerPrice: "90", reduceOnly: true },
  };
  const response = await handlePaperCommand(request(command), dependencies({
    loadAccount: async () => ({ epochNumber: 1, version: 0, cashBalance: "5000", availableMargin: "5000", currentMargin: "20", trailingVolume: "0", makerFraction: "0", position: { signedSize: "1", entryPrice: "100" } }),
    loadBook: async () => { bookCalls += 1; return { book, inputVersion: "book-v1" }; },
  }));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).response.status, "trigger_waiting");
  assertEquals(bookCalls, 0);
});

Deno.test("every limit-family order requires a limit price", async () => {
  for (const orderType of ["limit", "stop_limit", "take_limit"]) {
    const response = await handlePaperCommand(request({
      ...marketBuy,
      idempotencyKey: `missing-limit-${orderType}`,
      order: {
        ...marketBuy.order,
        orderType,
        limitPrice: null,
        triggerPrice: orderType === "limit" ? null : "90",
      },
    }), dependencies());
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error, "invalid_command");
  }
});
