import { assertEquals } from "@std/assert";
import { recordAssetAnalyticsSnapshot } from "../../monitor-market/analytics.ts";

Deno.test("analytics snapshot records every listed XYZ mark with its canonical bucket", async () => {
  let rpcName = "";
  let rpcArguments: Record<string, unknown> = {};
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcName = name;
      rpcArguments = args;
      return Promise.resolve({ data: 2, error: null });
    },
  };
  const fetchImpl = async () => new Response(JSON.stringify([
    { universe: [{ name: "xyz:ORCL" }, { name: "xyz:DRAM" }] },
    [{ markPx: "143.30", dayNtlVlm: "125000" }, { markPx: "51.472", dayNtlVlm: "75000" }],
  ]));
  const bucket = new Date("2026-08-06T23:20:00.000Z");

  assertEquals(await recordAssetAnalyticsSnapshot(client as never, bucket, fetchImpl as typeof fetch), 2);
  assertEquals(rpcName, "record_asset_price_samples");
  assertEquals(rpcArguments, {
    p_bucket: bucket.toISOString(),
    p_samples: [
      { asset: "xyz:ORCL", price: 143.3, dayVolume: 125000 },
      { asset: "xyz:DRAM", price: 51.472, dayVolume: 75000 },
    ],
  });
});
