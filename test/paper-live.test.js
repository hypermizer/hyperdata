import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_ENGINE_STALE_MS,
  PAPER_QUOTE_STALE_MS,
  paperEngineHealth,
  paperQuoteAssets,
  projectLivePaperAccount,
} from "../public/lib/paper-live.js";

const markets = new Map([
  ["BTC", { marginTiers: [{ lowerBound: 0, maxLeverage: 40, maintenanceRate: 0.0125, maintenanceDeduction: 0 }] }],
  ["xyz:DRAM", { marginTiers: [{ lowerBound: 0, maxLeverage: 10, maintenanceRate: 0.05, maintenanceDeduction: 0 }] }],
]);

test("paper quotes cover every open position plus the active order asset once", () => {
  assert.deepEqual(paperQuoteAssets([
    { asset: "BTC" }, { asset: "xyz:DRAM" }, { asset: "BTC" },
  ], "ETH"), ["BTC", "ETH", "xyz:DRAM"]);
});

test("live paper projection marks every position and recomputes account risk", () => {
  const now = 100_000;
  const projection = projectLivePaperAccount({
    summary: { cash_balance: "5000", equity: "5000", unrealized_pnl: "0", total_notional: "0", margin_used: "0", maintenance_margin: "0" },
    positions: [
      { asset: "BTC", signed_size: "1", entry_price: "100", mark_price: "100", margin_mode: "cross", isolated_margin: null },
      { asset: "xyz:DRAM", signed_size: "-2", entry_price: "50", mark_price: "50", margin_mode: "isolated", isolated_margin: "20" },
    ],
    leverageSettings: [{ asset: "BTC", leverage: 10 }],
    markets,
    quotes: new Map([
      ["BTC", { markPrice: 110, updatedAt: now - 10 }],
      ["xyz:DRAM", { markPrice: 45, updatedAt: now - 20 }],
    ]),
    now,
  });

  assert.deepEqual(projection.positions.map(({ mark_price }) => mark_price), [110, 45]);
  assert.equal(projection.summary.unrealized_pnl, 20);
  assert.equal(projection.summary.equity, 5020);
  assert.equal(projection.summary.total_notional, 200);
  assert.equal(projection.summary.margin_used, 31);
  assert.equal(projection.summary.maintenance_margin, 5.875);
  assert.deepEqual(projection.staleAssets, []);
});

test("stale live quotes fall back to persisted marks and are disclosed", () => {
  const now = 100_000;
  const projection = projectLivePaperAccount({
    summary: { cash_balance: "5000" },
    positions: [{ asset: "BTC", signed_size: "1", entry_price: "100", mark_price: "101", margin_mode: "cross" }],
    leverageSettings: [{ asset: "BTC", leverage: 10 }],
    markets,
    quotes: new Map([["BTC", { markPrice: 120, updatedAt: now - PAPER_QUOTE_STALE_MS - 1 }]]),
    now,
  });

  assert.equal(projection.positions[0].mark_price, 101);
  assert.deepEqual(projection.staleAssets, ["BTC"]);
});

test("paper engine health never calls an old or unhealthy processor live", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  assert.equal(paperEngineHealth(null, now).state, "unavailable");
  assert.equal(paperEngineHealth({ latest_finished_at: new Date(now - PAPER_ENGINE_STALE_MS - 1).toISOString() }, now).state, "stale");
  assert.equal(paperEngineHealth({ latest_finished_at: new Date(now - 1_000).toISOString(), latest_state: "partial" }, now).state, "degraded");
  assert.equal(paperEngineHealth({ latest_finished_at: new Date(now - 1_000).toISOString(), latest_state: "succeeded" }, now).state, "live");
});
