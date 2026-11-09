import { assertEquals, assertRejects } from "@std/assert";
import { PriceAlertEngine, parseMarkFrame, type Candidate, type StreamRule } from "../../../../scripts/price-stream/engine.ts";
const revision = "2026-11-09T10:00:00.000Z", timestamp = Date.parse(revision) + 1000;
function rule(id: string, direction = "above"): StreamRule {
  return { id, user_id: "owner", asset: "xyz:BTC", dex: "xyz", detector: "fixed_price", detector_version: 1,
    enabled: true, deleted_at: null, delivery: "both", updated_at: revision, configuration: { direction, target: 100 } };
}
Deno.test("a brief equality touch persists once even if the next tick reverses", async () => {
  let saved: Candidate[] = [];
  const engine = new PriceAlertEngine([], (rows) => { saved = rows; return Promise.resolve(); });
  engine.setRules([rule("above")]);
  engine.accept("xyz:BTC", 100, timestamp); engine.accept("xyz:BTC", 99, timestamp + 1); engine.accept("xyz:BTC", 101, timestamp + 2);
  await engine.settled();
  assertEquals(saved.length, 1); assertEquals(saved[0].mark, 100); assertEquals(saved[0].observedAt, new Date(timestamp).toISOString());
  const restarted = new PriceAlertEngine(saved, () => Promise.resolve());
  assertEquals([...restarted.pending.values()], saved);
});
Deno.test("invalid prices, other venues, pre-arming ticks, disabled and deleted rules never trigger", async () => {
  const engine = new PriceAlertEngine([], () => Promise.resolve());
  engine.setRules([rule("below", "below"), { ...rule("off"), enabled: false }, { ...rule("deleted"), deleted_at: revision }]);
  for (const price of [NaN, Infinity, 0, -1]) engine.accept("xyz:BTC", price, timestamp);
  engine.accept("BTC", 99, timestamp); engine.accept("xyz:BTC", 99, timestamp - 2000);
  assertEquals(engine.pending.size, 0);
  engine.accept("xyz:BTC", 100, timestamp); await engine.settled(); assertEquals(engine.pending.size, 1);
});
Deno.test("mark parser uses mark price rather than mid, oracle, trade, or unrelated frames", () => {
  assertEquals(parseMarkFrame(JSON.stringify({ channel: "activeAssetCtx", data: { coin: "BTC", ctx: { markPx: "100.01", midPx: "200", oraclePx: "300" } } })), { asset: "BTC", mark: 100.01 });
  for (const payload of ["invalid", JSON.stringify({ channel: "trades", data: [{ px: 100 }] }),
    JSON.stringify({ channel: "activeAssetCtx", data: { coin: "BTC", ctx: { markPx: "NaN" } } })]) assertEquals(parseMarkFrame(payload), null);
});
Deno.test("spool failure stops delivery instead of acknowledging a non-durable tick", async () => {
  const engine = new PriceAlertEngine([], () => Promise.reject(new Error("disk full")));
  engine.setRules([rule("a")]); engine.accept("xyz:BTC", 100, timestamp);
  await assertRejects(() => engine.settled(), Error, "disk full");
});
Deno.test("settled waits for ticks appended during an in-flight disk sync", async () => {
  const releases: Array<() => void> = [];
  const engine = new PriceAlertEngine([], () => new Promise<void>((resolve) => releases.push(resolve)));
  engine.setRules([rule("a")]); engine.accept("xyz:BTC", 100, timestamp);
  let settled = false; const waiting = engine.settled().then(() => { settled = true; });
  await Promise.resolve();
  engine.setRules([rule("b")]); engine.accept("xyz:BTC", 100, timestamp);
  releases[0]();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assertEquals(settled, false); assertEquals(releases.length, 2);
  releases[1](); await waiting; assertEquals(settled, true);
});
