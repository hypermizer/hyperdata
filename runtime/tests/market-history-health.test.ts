import { assertEquals } from "@std/assert";
import { marketHistoryFresh } from "../core-health.ts";
Deno.test("market history health requires every expected asset and fresh persisted observations", () => {
  const now = Date.now();
  const good = {
    connected: true,
    last_frame_at: new Date(now - 1000).toISOString(),
    last_persisted_at: new Date(now - 60000).toISOString(),
    assets_sampled: 349,
    assets_expected: 349,
  };
  assertEquals(marketHistoryFresh(good, now), true);
  for (
    const bad of [
      { ...good, assets_sampled: 348 },
      { ...good, assets_expected: 0 },
      { ...good, connected: false },
      { ...good, last_frame_at: new Date(now - 100000).toISOString() },
      { ...good, last_persisted_at: new Date(now - 125000).toISOString() },
      undefined,
    ]
  ) assertEquals(marketHistoryFresh(bad, now), false);
});
