export const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const PRICE_CHANGE_WINDOWS = [
  { label: "1w", milliseconds: 7 * 24 * ONE_HOUR_MS },
  { label: "1d", milliseconds: 24 * ONE_HOUR_MS },
  { label: "6h", milliseconds: 6 * 60 * 60 * 1000 },
  { label: "1h", milliseconds: ONE_HOUR_MS },
  { label: "30m", milliseconds: 30 * 60 * 1000 },
  { label: "10m", milliseconds: 10 * 60 * 1000 },
  { label: "5m", milliseconds: FIVE_MINUTES_MS },
];

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

export async function fetchMarketsForDex(dex, fetchImpl = fetch, dexMetadata = null) {
  const [meta, contexts] = await postInfo(
    { type: "metaAndAssetCtxs", dex },
    fetchImpl,
  );
  const marginTables = new Map(meta.marginTables ?? []);

  return meta.universe.map((asset, index) => {
    const context = contexts[index] ?? {};
    const markPrice = toNumber(context.markPx);
    const previousPrice = toNumber(context.prevDayPx);
    const marginTableId = asset.marginTableId ?? asset.maxLeverage;
    let priorMaintenanceRate = 0;
    let priorMaintenanceDeduction = 0;
    const marginTiers = [...(marginTables.get(marginTableId)?.marginTiers ?? [
      { lowerBound: "0", maxLeverage: asset.maxLeverage },
    ])].sort((left, right) => Number(left.lowerBound) - Number(right.lowerBound)).map((tier, tierIndex) => {
      const lowerBound = Number(tier.lowerBound);
      const maintenanceRate = 1 / (tier.maxLeverage * 2);
      const maintenanceDeduction = tierIndex === 0 ? 0
        : priorMaintenanceDeduction + lowerBound * (maintenanceRate - priorMaintenanceRate);
      priorMaintenanceRate = maintenanceRate;
      priorMaintenanceDeduction = maintenanceDeduction;
      return { lowerBound, maxLeverage: tier.maxLeverage, maintenanceRate, maintenanceDeduction };
    });

    return {
      id: asset.name,
      symbol: asset.name.includes(":")
        ? asset.name.split(":").at(-1)
        : asset.name,
      dex: dex || "Hyperliquid",
      dexId: dex,
      markPrice,
      markPriceRaw: context.markPx ?? null,
      previousPrice,
      changePercent:
        markPrice !== null && previousPrice
          ? ((markPrice - previousPrice) / previousPrice) * 100
          : null,
      volume24h: toNumber(context.dayNtlVlm),
      openInterest: toNumber(context.openInterest),
      funding: toNumber(context.funding),
      maxLeverage: asset.maxLeverage ?? null,
      sizeDecimals: asset.szDecimals ?? null,
      onlyIsolated: asset.onlyIsolated === true,
      marginMode: asset.marginMode ?? null,
      growthMode: asset.growthMode ?? null,
      deployerFeeScale: dexMetadata?.deployerFeeScale ?? null,
      marginTiers,
      isDelisted: Boolean(asset.isDelisted),
    };
  });
}

export async function fetchAllMarkets(fetchImpl = fetch) {
  const dexes = await postInfo({ type: "perpDexs" }, fetchImpl);
  const dexConfigs = [
    { name: "", deployerFeeScale: null },
    ...dexes.filter(Boolean).filter(({ name }) => name),
  ];
  const results = await Promise.allSettled(
    dexConfigs.map((dex) => fetchMarketsForDex(dex.name, fetchImpl, dex)),
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
    markPriceRaw: context.markPx ?? market.markPriceRaw,
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

export async function fetchPriceHistory(asset, fetchImpl = fetch, now = Date.now()) {
  const endTime = Number(now);
  const [hourlyCandles, fiveMinuteCandles] = await Promise.all([
    postInfo({
      type: "candleSnapshot",
      req: {
        coin: asset,
        interval: "1h",
        startTime: endTime - PRICE_CHANGE_WINDOWS[0].milliseconds - ONE_HOUR_MS,
        endTime,
      },
    }, fetchImpl),
    postInfo({
      type: "candleSnapshot",
      req: {
        coin: asset,
        interval: "5m",
        startTime: endTime - (24 * ONE_HOUR_MS) - FIVE_MINUTES_MS,
        endTime,
      },
    }, fetchImpl),
  ]);

  const pointsByTime = new Map();
  [...hourlyCandles, ...fiveMinuteCandles]
    .map((candle) => ({ time: toNumber(candle.T ?? candle.t), price: toNumber(candle.c) }))
    .filter(({ time, price }) => time !== null && price !== null)
    .forEach((point) => pointsByTime.set(point.time, point));
  return [...pointsByTime.values()].sort((left, right) => left.time - right.time);
}

export function buildPriceChangeSignals(markPrice, points, now = Date.now()) {
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    return PRICE_CHANGE_WINDOWS.map(({ label }) => ({
      label,
      direction: "neutral",
      intensity: "light",
      changePercent: null,
      referencePrice: null,
    }));
  }

  const volatility = estimateFiveMinuteVolatility(points);
  return PRICE_CHANGE_WINDOWS.map(({ label, milliseconds }) => {
    const previous = latestPointAtOrBefore(points, Number(now) - milliseconds);
    if (!previous) {
      return {
        label,
        direction: "neutral",
        intensity: "light",
        changePercent: null,
        referencePrice: null,
      };
    }

    const changePercent = ((markPrice - previous.price) / previous.price) * 100;
    const normalizedMove = Math.abs(changePercent) / Math.max(
      volatility * Math.sqrt(milliseconds / FIVE_MINUTES_MS),
      0.05 * Math.sqrt(milliseconds / (60 * 60 * 1000)),
    );
    return {
      label,
      changePercent,
      referencePrice: previous.price,
      direction: changePercent >= 0 ? "up" : "down",
      intensity: normalizedMove >= 3
        ? "strong"
        : normalizedMove >= 1.5 ? "medium" : "light",
    };
  });
}

function latestPointAtOrBefore(points, targetTime) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index].time <= targetTime) return points[index];
  }
  return null;
}

function estimateFiveMinuteVolatility(points) {
  const returns = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (current.time - previous.time > FIVE_MINUTES_MS * 2) continue;
    returns.push(Math.abs(((current.price - previous.price) / previous.price) * 100));
  }
  if (!returns.length) return 0;
  returns.sort((left, right) => left - right);
  return returns[Math.floor(returns.length / 2)];
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
