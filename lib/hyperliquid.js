export const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";

export async function postInfo(payload, fetchImpl = fetch) {
  const response = await fetchImpl(INFO_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API returned ${response.status}`);
  }

  return response.json();
}

export async function fetchDexNames(fetchImpl = fetch) {
  const dexes = await postInfo({ type: "perpDexs" }, fetchImpl);
  return [
    "",
    ...dexes
      .filter(Boolean)
      .map((dex) => dex.name)
      .filter(Boolean),
  ];
}

export async function fetchMarketsForDex(dex, fetchImpl = fetch) {
  const [meta, contexts] = await postInfo(
    { type: "metaAndAssetCtxs", dex },
    fetchImpl,
  );

  return meta.universe.map((asset, index) => {
    const context = contexts[index] ?? {};
    const markPrice = toNumber(context.markPx);
    const previousPrice = toNumber(context.prevDayPx);

    return {
      id: asset.name,
      symbol: asset.name.includes(":")
        ? asset.name.split(":").at(-1)
        : asset.name,
      dex: dex || "Hyperliquid",
      dexId: dex,
      markPrice,
      previousPrice,
      changePercent:
        markPrice !== null && previousPrice
          ? ((markPrice - previousPrice) / previousPrice) * 100
          : null,
      volume24h: toNumber(context.dayNtlVlm),
      openInterest: toNumber(context.openInterest),
      funding: toNumber(context.funding),
      maxLeverage: asset.maxLeverage ?? null,
      isDelisted: Boolean(asset.isDelisted),
    };
  });
}

export async function fetchAllMarkets(fetchImpl = fetch) {
  const dexNames = await fetchDexNames(fetchImpl);
  const results = await Promise.allSettled(
    dexNames.map((dex) => fetchMarketsForDex(dex, fetchImpl)),
  );

  const markets = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );

  if (!markets.length) {
    const firstError = results.find((result) => result.status === "rejected");
    throw firstError?.reason ?? new Error("No Hyperliquid markets were returned");
  }

  return markets.filter((market) => !market.isDelisted);
}

export async function fetchMarketsByDex(dexIds, fetchImpl = fetch) {
  const uniqueDexIds = [...new Set(dexIds)];
  const results = await Promise.all(
    uniqueDexIds.map((dex) => fetchMarketsForDex(dex, fetchImpl)),
  );
  return results.flat();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
