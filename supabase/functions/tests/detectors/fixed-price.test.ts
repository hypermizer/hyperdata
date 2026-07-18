import { assertEquals } from "@std/assert";
import { evaluateFixedPrice } from "../../_shared/detectors/fixed-price.ts";
import type { AlertRule, MarketObservation } from "../../_shared/types.ts";
const observation = { asset: "BTC", dex: "", bucket: "2026-01-01T00:00:00Z", observed_at: "2026-01-01T00:00:01Z", mark_price: 100,
  oracle_price: 100, mid_price: 100, open_interest: 1, day_volume: 1 } satisfies MarketObservation;
const rule = { id: "r", user_id: "u", asset: "BTC", dex: "", detector: "fixed_price", detector_version: 1, configuration: { direction: "above", target: 100 },
  delivery: "email", enabled: true, deleted_at: null } satisfies AlertRule;
Deno.test("fixed-price comparisons are inclusive", () => assertEquals(evaluateFixedPrice(rule, observation).qualifies, true));
