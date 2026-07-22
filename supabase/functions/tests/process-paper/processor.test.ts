import { assertEquals } from "@std/assert";
import {
  BASE_SNAPSHOT_WEIGHT,
  buildProcessorWork,
  estimateSnapshotWeight,
  processPaperBatch,
  type ProcessorSnapshot,
} from "../../process-paper/processor.ts";

Deno.test("recent fills keep closed positions eligible for funding settlement", () => {
  assertEquals(buildProcessorWork([], [], [{ epoch_id: "closed-account", asset: "OIL" }]), [
    { asset: "OIL", hasPosition: false, requiresTradeReplay: false, accountIds: ["closed-account"] },
  ]);
});

Deno.test("only resting-order work requires recent-trade replay", () => {
  assertEquals(buildProcessorWork(
    [{ epoch_id: "position", asset: "BTC" }],
    [{ epoch_id: "order", asset: "XYZ100" }],
    [{ epoch_id: "fill", asset: "DRAM" }],
    [{ epoch_id: "strategy", asset: "ORCL" }],
  ), [
    { asset: "BTC", hasPosition: true, requiresTradeReplay: false, accountIds: ["position"] },
    { asset: "XYZ100", hasPosition: false, requiresTradeReplay: true, accountIds: ["order"] },
    { asset: "DRAM", hasPosition: false, requiresTradeReplay: false, accountIds: ["fill"] },
    { asset: "ORCL", hasPosition: false, requiresTradeReplay: false, accountIds: ["strategy"] },
  ]);
  assertEquals(estimateSnapshotWeight({ asset: "BTC", hasPosition: true, requiresTradeReplay: false, accountIds: ["position"] }), 22);
  assertEquals(estimateSnapshotWeight({ asset: "XYZ100", hasPosition: false, requiresTradeReplay: true, accountIds: ["order"] }), 42);
});

Deno.test("one asset fetch advances every account in deterministic order", async () => {
  const fetched: string[] = [];
  const processed: string[] = [];
  const persisted: string[] = [];
  const result = await processPaperBatch({
    loadWork: async () => [{ asset: "ORCL", hasPosition: true, requiresTradeReplay: false, accountIds: ["b", "a", "a"] }],
    fetchSnapshot: async (work) => {
      fetched.push(work.asset);
      return { asset: work.asset, inputVersion: "v1", apiWeight: 42, degraded: false, payload: {} };
    },
    processAccount: async (accountId, snapshot) => {
      processed.push(`${accountId}:${snapshot.inputVersion}`);
      return { mutated: true };
    },
    persistSnapshot: async (snapshot) => { persisted.push(snapshot.inputVersion); },
  }, 100);
  assertEquals(fetched, ["ORCL"]);
  assertEquals(processed, ["a:v1", "b:v1"]);
  assertEquals(persisted, ["v1"]);
  assertEquals(result, {
    state: "succeeded", assetsProcessed: 1, accountsProcessed: 2, apiWeight: 42,
    reconciliationFailures: 0, degradedAssets: [], strategyEvaluations: 0, strategyActions: 0,
  });
});

Deno.test("strategy-only work shares the existing asset snapshot and processor invocation", async () => {
  assertEquals(buildProcessorWork([], [], [], [{ epoch_id: "epoch-1", asset: "DRAM" }]), [
    { asset: "DRAM", hasPosition: false, requiresTradeReplay: false, accountIds: ["epoch-1"] },
  ]);
  const result = await processPaperBatch({
    loadWork: async () => buildProcessorWork([], [], [], [{ epoch_id: "epoch-1", asset: "DRAM" }]),
    fetchSnapshot: async () => ({ asset: "DRAM", inputVersion: "v1", apiWeight: 1, degraded: false, payload: {} }),
    processAccount: async () => ({ mutated: false, accepted: true }),
    processStrategies: async () => ({ evaluations: 1, actions: 0 }),
  }, 10);
  assertEquals(result.strategyEvaluations, 1);
  assertEquals(result.strategyActions, 0);
});

Deno.test("a strategy failure degrades its asset without aborting paper processing", async () => {
  const result = await processPaperBatch({
    loadWork: async () => [{ asset: "BTC", hasPosition: true, requiresTradeReplay: false, accountIds: ["epoch-1"] }],
    fetchSnapshot: async () => ({ asset: "BTC", inputVersion: "v1", apiWeight: 1, degraded: false, payload: {} }),
    processAccount: async () => ({ mutated: true, accepted: true }),
    processStrategies: async () => { throw new Error("candle_gap"); },
  }, 10);
  assertEquals(result.state, "partial");
  assertEquals(result.degradedAssets, [{ asset: "BTC", reason: "strategy:candle_gap" }]);
});

Deno.test("diagnostic snapshot persists while rejected accounts keep their own cursor", async () => {
  const persisted: string[] = [];
  const result = await processPaperBatch({
    loadWork: async () => [{ asset: "ORCL", hasPosition: true, requiresTradeReplay: false, accountIds: ["accepted", "stale"] }],
    fetchSnapshot: async () => ({ asset: "ORCL", inputVersion: "trades-v2", apiWeight: 1, degraded: false, payload: {} }),
    processAccount: async (accountId) => ({ mutated: accountId === "accepted", accepted: accountId !== "stale" }),
    persistSnapshot: async (snapshot) => { persisted.push(snapshot.inputVersion); },
  }, 10);
  assertEquals(persisted, ["trades-v2"]);
  assertEquals(result.state, "partial");
  assertEquals(result.degradedAssets, [{ asset: "ORCL", reason: "account_snapshot_rejected" }]);
});

Deno.test("risk-bearing assets consume budget before resting-only assets", async () => {
  const fetched: string[] = [];
  const processed: string[] = [];
  const snapshot = (asset: string): ProcessorSnapshot =>
    ({ asset, inputVersion: asset, apiWeight: 25, degraded: false, payload: {} });
  const result = await processPaperBatch({
    loadWork: async () => [
      { asset: "XYZ100", hasPosition: false, requiresTradeReplay: true, accountIds: ["resting"] },
      { asset: "ORCL", hasPosition: true, requiresTradeReplay: false, accountIds: ["risk"] },
    ],
    estimateSnapshotWeight: () => 25,
    fetchSnapshot: async (work) => { fetched.push(work.asset); return snapshot(work.asset); },
    processAccount: async (accountId) => { processed.push(accountId); return { mutated: true }; },
  }, 25);
  assertEquals(fetched, ["ORCL"]);
  assertEquals(processed, ["risk"]);
  assertEquals(result.state, "partial");
  assertEquals(result.apiWeight, 25);
  assertEquals(result.degradedAssets, [{ asset: "XYZ100", reason: "api_budget_exhausted" }]);
});

Deno.test("shared refresh weight is charged once while four recurring assets fit the production budget", async () => {
  let fetched = 0;
  const result = await processPaperBatch({
    loadWork: async () => ["A", "B", "C", "D"].map((asset) => ({ asset, hasPosition: true, requiresTradeReplay: false, accountIds: [asset] })),
    estimateSnapshotWeight: () => BASE_SNAPSHOT_WEIGHT,
    fetchSnapshot: async (work) => ({
      asset: work.asset, inputVersion: work.asset,
      apiWeight: fetched++ === 0 ? 102 : BASE_SNAPSHOT_WEIGHT + 20,
      degraded: false, payload: {},
    }),
    processAccount: async () => ({ mutated: true, accepted: true }),
  }, 500);
  assertEquals(result.state, "succeeded");
  assertEquals(result.assetsProcessed, 4);
  assertEquals(result.apiWeight, 228);
  assertEquals(result.degradedAssets, []);
});

Deno.test("an asset failure is isolated and reconciliation failure makes run partial", async () => {
  const result = await processPaperBatch({
    loadWork: async () => [
      { asset: "BAD", hasPosition: true, requiresTradeReplay: false, accountIds: ["x"] },
      { asset: "ORCL", hasPosition: true, requiresTradeReplay: false, accountIds: ["y"] },
    ],
    fetchSnapshot: async (work) => {
      if (work.asset === "BAD") throw new Error("cursor_gap");
      return { asset: work.asset, inputVersion: "v", apiWeight: 2, degraded: false, payload: {} };
    },
    processAccount: async () => ({ mutated: false, reconciliationFailure: true }),
  }, 100);
  assertEquals(result.state, "partial");
  assertEquals(result.assetsProcessed, 1);
  assertEquals(result.accountsProcessed, 1);
  assertEquals(result.reconciliationFailures, 1);
  assertEquals(result.degradedAssets, [
    { asset: "BAD", reason: "cursor_gap" },
    { asset: "ORCL", reason: "account_snapshot_rejected" },
  ]);
});

Deno.test("budgeted assets rotate without placing resting work ahead of risk", async () => {
  const fetched: string[] = [];
  await processPaperBatch({
    loadWork: async () => [
      { asset: "A", hasPosition: true, requiresTradeReplay: false, accountIds: ["a"] },
      { asset: "B", hasPosition: true, requiresTradeReplay: false, accountIds: ["b"] },
      { asset: "C", hasPosition: false, requiresTradeReplay: false, accountIds: ["c"] },
    ],
    estimateSnapshotWeight: () => 10,
    fetchSnapshot: async (work) => {
      fetched.push(work.asset); return { asset: work.asset, inputVersion: work.asset, apiWeight: 10, degraded: false, payload: {} };
    },
    processAccount: async () => ({ mutated: true }),
  }, 20, 1);
  assertEquals(fetched, ["B", "A"]);
});
