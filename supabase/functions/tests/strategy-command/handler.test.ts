import { assertEquals } from "@std/assert";
import { handleStrategyCommand, parseStrategyCommand, type StrategyCommandDependencies } from "../../strategy-command/handler.ts";

const owner = { id: "user-1", email: "jasonblick@zohomail.com" };
function dependencies(overrides: Partial<StrategyCommandDependencies> = {}): StrategyCommandDependencies {
  return { enabled: true, authenticate: async () => owner, execute: async (_user, command) => ({ type: command.type, id: "result-1" }), ...overrides };
}
function request(body: unknown, token = "valid") {
  return new Request("https://example.test", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

Deno.test("strategy commands require the exact owner", async () => {
  assertEquals((await handleStrategyCommand(request({}), dependencies({ authenticate: async () => null }))).status, 401);
  assertEquals((await handleStrategyCommand(request({}), dependencies({ authenticate: async () => ({ id: "x", email: "other@example.com" }) }))).status, 401);
});

Deno.test("disabled command gate rejects before execution", async () => {
  let executed = false;
  const response = await handleStrategyCommand(request({ type: "create_definition", name: "RSI", marginAllocationPct: 10 }), dependencies({ enabled: false, execute: async () => { executed = true; } }));
  assertEquals(response.status, 503);
  assertEquals(executed, false);
});

Deno.test("valid create, assignment, pause, and backtest contracts execute", async () => {
  const uuid = "00000000-0000-4000-8000-000000000001";
  const commands = [
    { type: "create_definition", name: "Dual RSI", marginAllocationPct: 10 },
    { type: "create_assignment", definitionId: uuid, accountId: uuid, asset: "xyz:DRAM", marginAllocationPct: 10 },
    { type: "set_assignment_state", assignmentId: uuid, state: "paused", pauseMode: "keep_exit_management" },
    { type: "queue_backtest", revisionId: uuid, assets: ["xyz:DRAM", "xyz:XYZ100", "BTC"], start: "2026-07-01T00:00:00Z", end: "2026-07-21T00:00:00Z", initialCapital: 5000 },
  ];
  for (const command of commands) {
    const response = await handleStrategyCommand(request(command), dependencies());
    assertEquals(response.status, 200);
  }
});

Deno.test("invalid percentages, assets, date ranges, and identifiers fail closed", () => {
  const uuid = "00000000-0000-4000-8000-000000000001";
  assertEquals(parseStrategyCommand({ type: "create_definition", name: "x", marginAllocationPct: 0 }), null);
  assertEquals(parseStrategyCommand({ type: "create_assignment", definitionId: uuid, accountId: uuid, asset: "BAD ASSET", marginAllocationPct: 10 }), null);
  assertEquals(parseStrategyCommand({ type: "queue_backtest", revisionId: "bad", assets: ["BTC"], start: "x", end: "y", initialCapital: 5000 }), null);
});

Deno.test("oversized request bodies are rejected", async () => {
  const response = await handleStrategyCommand(request({ type: "create_definition", name: "x".repeat(17_000), marginAllocationPct: 10 }), dependencies());
  assertEquals(response.status, 413);
});
