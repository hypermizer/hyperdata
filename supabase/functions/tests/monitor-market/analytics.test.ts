import { assertEquals } from "@std/assert";
import { recordAssetAnalyticsSnapshot } from "../../monitor-market/analytics.ts";

Deno.test("analytics snapshot records every listed market across all discovered DEXes", async () => {
  let rpcName = "";
  let rpcArguments: Record<string, unknown> = {};
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcName = name;
      rpcArguments = args;
      return Promise.resolve({ data: 7, error: null });
    },
  };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const { type, dex } = JSON.parse(String(init?.body));
    if (type === "perpDexs") return new Response(JSON.stringify([{ name: "xyz" }, { name: "para" }, { name: "mkts" }, { name: "io" }]));
    const payloads: Record<string, unknown> = {
      "": [{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ markPx: "118000", dayNtlVlm: "1000000" }, { markPx: "4200", dayNtlVlm: "500000" }]],
      xyz: [{ universe: [{ name: "xyz:ORCL" }, { name: "xyz:DRAM" }] }, [{ markPx: "143.30", dayNtlVlm: "125000" }, { markPx: "51.472", dayNtlVlm: "75000" }]],
      para: [{ universe: [{ name: "para:10Y" }] }, [{ markPx: "4.91", dayNtlVlm: "381831" }]],
      mkts: [{ universe: [{ name: "mkts:USBOND" }] }, [{ markPx: "78.91", dayNtlVlm: "487217" }]],
      io: [{ universe: [{ name: "io:ANTH" }] }, [{ markPx: "2085.3", dayNtlVlm: "6682461" }]],
    };
    return new Response(JSON.stringify(payloads[dex]));
  };
  const bucket = new Date("2026-08-06T23:20:00.000Z");

  assertEquals(await recordAssetAnalyticsSnapshot(client as never, bucket, fetchImpl as typeof fetch), 7);
  assertEquals(rpcName, "record_asset_price_samples");
  assertEquals(rpcArguments, {
    p_bucket: bucket.toISOString(),
    p_samples: [
      { asset: "BTC", price: 118000, dayVolume: 1000000 },
      { asset: "ETH", price: 4200, dayVolume: 500000 },
      { asset: "xyz:ORCL", price: 143.3, dayVolume: 125000 },
      { asset: "xyz:DRAM", price: 51.472, dayVolume: 75000 },
      { asset: "para:10Y", price: 4.91, dayVolume: 381831 },
      { asset: "mkts:USBOND", price: 78.91, dayVolume: 487217 },
      { asset: "io:ANTH", price: 2085.3, dayVolume: 6682461 },
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
    const { type, dex } = JSON.parse(String(init?.body));
    if (type === "perpDexs") return new Response(JSON.stringify([{ name: "xyz" }]));
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

Deno.test("analytics snapshot falls back to core DEXes when discovery fails", async () => {
  let samples: unknown[] = [];
  const client = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      samples = args.p_samples as unknown[];
      return Promise.resolve({ data: 2, error: null });
    },
  };
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const { type, dex } = JSON.parse(String(init?.body));
    if (type === "perpDexs") throw new Error("discovery unavailable");
    const asset = dex === "xyz" ? "xyz:ORCL" : "BTC";
    return new Response(JSON.stringify([
      { universe: [{ name: asset }] },
      [{ markPx: dex === "xyz" ? "143.30" : "118000", dayNtlVlm: "1000" }],
    ]));
  };

  assertEquals(
    await recordAssetAnalyticsSnapshot(client as never, new Date("2026-08-06T23:22:00.000Z"), fetchImpl as typeof fetch),
    2,
  );
  assertEquals(samples, [
    { asset: "BTC", price: 118000, dayVolume: 1000 },
    { asset: "xyz:ORCL", price: 143.3, dayVolume: 1000 },
  ]);
});
