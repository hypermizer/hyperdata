import { assertEquals } from "@std/assert";
import { processPaperBatch, type ProcessorSnapshot } from "../../process-paper/processor.ts";

Deno.test("one asset fetch advances every account in deterministic order", async () => {
  const fetched: string[] = [];
  const processed: string[] = [];
  const result = await processPaperBatch({
    loadWork: async () => [{ asset: "ORCL", hasPosition: true, accountIds: ["b", "a", "a"] }],
    fetchSnapshot: async (asset) => {
      fetched.push(asset);
      return { asset, inputVersion: "v1", apiWeight: 42, degraded: false, payload: {} };
    },
    processAccount: async (accountId, snapshot) => {
      processed.push(`${accountId}:${snapshot.inputVersion}`);
      return { mutated: true };
    },
  }, 100);
  assertEquals(fetched, ["ORCL"]);
  assertEquals(processed, ["a:v1", "b:v1"]);
  assertEquals(result, {
    state: "succeeded", assetsProcessed: 1, accountsProcessed: 2, apiWeight: 42,
    reconciliationFailures: 0, degradedAssets: [],
  });
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
    fetchSnapshot: async (asset) => { fetched.push(asset); return snapshot(asset); },
    processAccount: async (accountId) => { processed.push(accountId); return { mutated: true }; },
  }, 25);
  assertEquals(fetched, ["ORCL", "XYZ100"]);
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
    fetchSnapshot: async (asset) => {
      if (asset === "BAD") throw new Error("cursor_gap");
      return { asset, inputVersion: "v", apiWeight: 2, degraded: false, payload: {} };
    },
    processAccount: async () => ({ mutated: false, reconciliationFailure: true }),
  }, 100);
  assertEquals(result.state, "partial");
  assertEquals(result.assetsProcessed, 1);
  assertEquals(result.accountsProcessed, 1);
  assertEquals(result.reconciliationFailures, 1);
  assertEquals(result.degradedAssets, [{ asset: "BAD", reason: "cursor_gap" }]);
});
