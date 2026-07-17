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

export function applyLiveMarketContext(market, context) {
  const markPrice = toNumber(context.markPx) ?? market.markPrice;
  const previousPrice = toNumber(context.prevDayPx) ?? market.previousPrice;

  return {
    ...market,
    markPrice,
    previousPrice,
    changePercent:
      markPrice !== null && previousPrice
        ? ((markPrice - previousPrice) / previousPrice) * 100
        : null,
    volume24h: toNumber(context.dayNtlVlm) ?? market.volume24h,
    openInterest: toNumber(context.openInterest) ?? market.openInterest,
  };
}

export async function fetchAverageDailyVolume(asset, fetchImpl = fetch, now = Date.now()) {
  const endTime = Number(now);
  const startTime = endTime - (30 * 24 * 60 * 60 * 1000);
  const candles = await postInfo({
    type: "candleSnapshot",
    req: { coin: asset, interval: "1d", startTime, endTime },
  }, fetchImpl);
  const dailyVolumes = candles
    .map((candle) => ({ close: toNumber(candle.c), volume: toNumber(candle.v) }))
    .filter(({ close, volume }) => close !== null && volume !== null)
    .map(({ close, volume }) => close * volume);

  if (!dailyVolumes.length) return null;
  return dailyVolumes.reduce((total, volume) => total + volume, 0) / dailyVolumes.length;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
