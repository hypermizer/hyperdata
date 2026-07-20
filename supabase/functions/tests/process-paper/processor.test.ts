import { assertEquals } from "@std/assert";
import { processPaperBatch, type ProcessorSnapshot } from "../../process-paper/processor.ts";

Deno.test("one asset fetch advances every account in deterministic order", async () => {
  const fetched: string[] = [];
  const processed: string[] = [];
  const persisted: string[] = [];
  const result = await processPaperBatch({
    loadWork: async () => [{ asset: "ORCL", hasPosition: true, accountIds: ["b", "a", "a"] }],
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
    reconciliationFailures: 0, degradedAssets: [],
  });
});

Deno.test("diagnostic snapshot persists while rejected accounts keep their own cursor", async () => {
  const persisted: string[] = [];
  const result = await processPaperBatch({
    loadWork: async () => [{ asset: "ORCL", hasPosition: true, accountIds: ["accepted", "stale"] }],
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
      { asset: "XYZ100", hasPosition: false, accountIds: ["resting"] },
      { asset: "ORCL", hasPosition: true, accountIds: ["risk"] },
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

Deno.test("an asset failure is isolated and reconciliation failure makes run partial", async () => {
  const result = await processPaperBatch({
    loadWork: async () => [
      { asset: "BAD", hasPosition: true, accountIds: ["x"] },
      { asset: "ORCL", hasPosition: true, accountIds: ["y"] },
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
      { asset: "A", hasPosition: true, accountIds: ["a"] },
      { asset: "B", hasPosition: true, accountIds: ["b"] },
      { asset: "C", hasPosition: false, accountIds: ["c"] },
    ],
    estimateSnapshotWeight: () => 10,
    fetchSnapshot: async (work) => {
      fetched.push(work.asset); return { asset: work.asset, inputVersion: work.asset, apiWeight: 10, degraded: false, payload: {} };
    },
    processAccount: async () => ({ mutated: true }),
  }, 20, 1);
  assertEquals(fetched, ["B", "A"]);
});
