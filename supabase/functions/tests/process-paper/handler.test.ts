import { assertEquals } from "@std/assert";
import { handleProcessPaper, type ProcessPaperDependencies, tenSecondBucket } from "../../process-paper/handler.ts";

function dependencies(overrides: Partial<ProcessPaperDependencies> = {}) {
  const calls: string[] = [];
  const value: ProcessPaperDependencies = {
    enabled: true,
    schedulerSecret: "scheduler-secret",
    claim: async (bucket) => { calls.push(`claim:${bucket}`); return true; },
    process: async () => {
      calls.push("process");
      return { state: "succeeded", assetsProcessed: 1, accountsProcessed: 2, apiWeight: 42,
        reconciliationFailures: 0, degradedAssets: [], strategyEvaluations: 0, strategyActions: 0 };
    },
    finish: async (bucket, state) => { calls.push(`finish:${bucket}:${state}`); },
    now: () => Date.parse("2026-07-19T20:00:09.999Z"),
    ...overrides,
  };
  return { value, calls };
}

const authorized = () => new Request("https://example.test/process-paper", {
  method: "POST", headers: { "x-monitor-secret": "scheduler-secret" },
});

Deno.test("scheduler authorization rejects anonymous and user JWT calls before claim", async () => {
  const { value, calls } = dependencies();
  for (const request of [
    new Request("https://example.test/process-paper", { method: "POST" }),
    new Request("https://example.test/process-paper", { method: "POST", headers: { authorization: "Bearer user-jwt" } }),
    new Request("https://example.test/process-paper", { method: "POST", headers: { "x-monitor-secret": "wrong" } }),
  ]) assertEquals((await handleProcessPaper(request, value)).status, 401);
  assertEquals(calls, []);
});

Deno.test("disabled processor exits without claiming state", async () => {
  const { value, calls } = dependencies({ enabled: false });
  assertEquals(await (await handleProcessPaper(authorized(), value)).json(), { status: "disabled" });
  assertEquals(calls, []);
});

Deno.test("claimed bucket runs once and records canonical metrics", async () => {
  const { value, calls } = dependencies();
  const response = await handleProcessPaper(authorized(), value);
  assertEquals(response.status, 200);
  assertEquals(calls, [
    "claim:2026-07-19T20:00:00.000Z", "process", "finish:2026-07-19T20:00:00.000Z:succeeded",
  ]);
});

Deno.test("overlap exits successfully without processing", async () => {
  const { value, calls } = dependencies({ claim: async () => { calls.push("claim"); return false; } });
  assertEquals((await handleProcessPaper(authorized(), value)).status, 200);
  assertEquals(calls, ["claim"]);
});

Deno.test("processor failure releases lease with failed health", async () => {
  const { value, calls } = dependencies({ process: async () => { calls.push("process"); throw new Error("boom"); } });
  const response = await handleProcessPaper(authorized(), value);
  assertEquals(response.status, 500);
  assertEquals(calls.at(-1), "finish:2026-07-19T20:00:00.000Z:failed");
});

Deno.test("ten-second buckets are stable at boundaries", () => {
  assertEquals(tenSecondBucket(Date.parse("2026-07-19T20:00:19.999Z")), "2026-07-19T20:00:10.000Z");
  assertEquals(tenSecondBucket(Date.parse("2026-07-19T20:00:20.000Z")), "2026-07-19T20:00:20.000Z");
});
