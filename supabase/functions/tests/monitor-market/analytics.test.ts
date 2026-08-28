import { assertEquals } from "@std/assert";
import { recordAssetAnalyticsSnapshot } from "../../monitor-market/analytics.ts";

Deno.test("analytics snapshot records every listed native crypto and XYZ mark", async () => {
  let rpcName = "";
  let rpcArguments: Record<string, unknown> = {};
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcName = name;
      rpcArguments = args;
      return Promise.resolve({ data: 4, error: null });
    },
  };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const { dex } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(dex === "xyz" ? [
      { universe: [{ name: "xyz:ORCL" }, { name: "xyz:DRAM" }] },
      [{ markPx: "143.30", dayNtlVlm: "125000" }, { markPx: "51.472", dayNtlVlm: "75000" }],
    ] : [
      { universe: [{ name: "BTC" }, { name: "ETH" }] },
      [{ markPx: "118000", dayNtlVlm: "1000000" }, { markPx: "4200", dayNtlVlm: "500000" }],
    ]));
  };
  const bucket = new Date("2026-08-06T23:20:00.000Z");

  assertEquals(await recordAssetAnalyticsSnapshot(client as never, bucket, fetchImpl as typeof fetch), 4);
  assertEquals(rpcName, "record_asset_price_samples");
  assertEquals(rpcArguments, {
    p_bucket: bucket.toISOString(),
    p_samples: [
      { asset: "BTC", price: 118000, dayVolume: 1000000 },
      { asset: "ETH", price: 4200, dayVolume: 500000 },
      { asset: "xyz:ORCL", price: 143.3, dayVolume: 125000 },
      { asset: "xyz:DRAM", price: 51.472, dayVolume: 75000 },
    ],
  });
});

Deno.test("analytics snapshot persists the healthy DEX when its peer fails", async () => {
  let samples: unknown[] = [];
  const client = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      samples = args.p_samples as unknown[];
      return Promise.resolve({ data: 1, error: null });
    },
  };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const { dex } = JSON.parse(String(init?.body));
    if (dex === "") throw new Error("native unavailable");
    return new Response(JSON.stringify([
      { universe: [{ name: "xyz:ORCL" }] },
      [{ markPx: "143.30", dayNtlVlm: "125000" }],
    ]));
  };

  assertEquals(
    await recordAssetAnalyticsSnapshot(client as never, new Date("2026-08-06T23:21:00.000Z"), fetchImpl as typeof fetch),
    1,
  );
  assertEquals(samples, [{ asset: "xyz:ORCL", price: 143.3, dayVolume: 125000 }]);
});
