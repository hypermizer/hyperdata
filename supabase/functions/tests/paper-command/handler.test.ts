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
    loadAccount: async () => ({ epochNumber: 1, version: 0, cashBalance: "5000", availableMargin: "5000", position: null }),
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
  assertEquals(body.position, { signedSize: "0.75", entryPrice: "100.33333333333333333333" });
  assertEquals(body.ledger, [{ entry_type: "fee", amount: "-0.0338625", asset: "xyz:ORCL", source_timestamp: "1970-01-01T00:00:01.000Z" }]);
  assertEquals(applied, body);
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
    loadAccount: async () => ({ epochNumber: 1, version: 0, cashBalance: "5000", availableMargin: "5000", position: { signedSize: "1", entryPrice: "100" } }),
    loadBook: async () => { bookCalls += 1; return { book, inputVersion: "book-v1" }; },
  }));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).response.status, "trigger_waiting");
  assertEquals(bookCalls, 0);
});
