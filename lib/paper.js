export function normalizeAccountName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 60) throw new Error("Account name must be 1–60 characters.");
  return name;
}

export function normalizeStartingCapital(value) {
  const capital = String(value ?? "").trim();
  if (!(Number(capital) > 0)) throw new Error("Starting capital must be positive.");
  if (Number(capital) > 1_000_000_000) throw new Error("Starting capital is too large.");
  return capital;
}

export function normalizePaperOrder(input, maxLeverage = Infinity) {
  const asset = String(input.asset ?? "").trim();
  const size = String(input.size ?? "").trim();
  const leverage = Number(input.leverage);
  const limitPrice = String(input.limitPrice ?? "").trim() || null;
  const triggerPrice = String(input.triggerPrice ?? "").trim() || null;
  const orderType = String(input.orderType);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(asset)) throw new Error("Enter a valid asset.");
  if (!(Number(size) > 0)) throw new Error("Amount must be greater than 0 shares.");
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error("Leverage must be a positive integer.");
  if (leverage > maxLeverage) throw new Error(`Leverage cannot exceed this asset's maximum of ${maxLeverage}×.`);
  if (!["buy", "sell"].includes(input.side)) throw new Error("Invalid side.");
  if (!["market", "limit", "stop_market", "stop_limit", "take_market", "take_limit"].includes(orderType)) throw new Error("Invalid order type.");
  if (orderType.includes("limit") && !(Number(limitPrice) > 0)) throw new Error("Limit price is required.");
  if ((orderType.startsWith("stop_") || orderType.startsWith("take_")) && !(Number(triggerPrice) > 0)) throw new Error("Trigger price is required.");
  return {
    asset, side: input.side, size, orderType,
    timeInForce: orderType === "market" || orderType.endsWith("_market") ? null : input.timeInForce,
    limitPrice, triggerPrice, leverage, marginMode: input.marginMode,
    reduceOnly: Boolean(input.reduceOnly),
  };
}

export function paperOrderPreview(input) {
  const markPrice = positiveNumber(input.markPrice);
  const limitPrice = positiveNumber(input.limitPrice);
  const executionPrice = positiveNumber(input.executionPrice);
  const price = input.orderType === "limit" ? limitPrice : (executionPrice ?? markPrice);
  const size = positiveNumber(input.size);
  const leverage = positiveNumber(input.leverage);
  const availableMargin = Math.max(0, Number(input.availableMargin) || 0);
  const currentPosition = Number(input.currentPosition) || 0;
  const feeRate = Number(input.feeRate) || 0;
  const validOrder = price !== null && size !== null && leverage !== null;
  const orderValue = validOrder ? size * price : null;
  const marginRequired = orderValue === null ? null : input.reduceOnly ? 0
    : orderValue / effectiveLeverage(orderValue, leverage, input.marginTiers);
  const estimatedFee = orderValue === null ? null : orderValue * feeRate;
  const reducesPosition = input.side === "sell" ? currentPosition > 0 : currentPosition < 0;
  const maxSize = input.reduceOnly
    ? (reducesPosition ? Math.abs(currentPosition) : 0)
    : maximumOrderSize(availableMargin, leverage, price, input.marginTiers);
  return {
    price,
    orderValue,
    marginRequired,
    estimatedFee,
    estimatedCost: marginRequired === null ? null : marginRequired + estimatedFee,
    maxSize,
    currentPosition,
    availableMargin,
  };
}

export function paperFeeRates(schedule, trailingVolume, makerVolume) {
  const volume = Math.max(0, Number(trailingVolume) || 0);
  const makerFraction = volume > 0 ? Math.max(0, Number(makerVolume) || 0) / volume : 0;
  const volumeTiers = [...(schedule?.volumeTiers ?? [])]
    .sort((left, right) => Number(left.minimumVolume) - Number(right.minimumVolume));
  let selected = volumeTiers[0] ?? { makerRate: 0.00015, takerRate: 0.00045 };
  for (const tier of volumeTiers) {
    if (volume >= Number(tier.minimumVolume)) selected = tier;
  }
  let maker = Number(selected.makerRate);
  for (const tier of [...(schedule?.makerFractionTiers ?? [])]
    .sort((left, right) => Number(left.minimumMakerFraction) - Number(right.minimumMakerFraction))) {
    if (makerFraction >= Number(tier.minimumMakerFraction)) maker = Math.min(maker, Number(tier.makerRate));
  }
  return { maker, taker: Number(selected.takerRate) };
}

export function normalizePaperFeeSchedule(payload) {
  const schedule = payload?.feeSchedule;
  const number = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("Fee schedule is unavailable.");
    return parsed;
  };
  if (!schedule || !Array.isArray(schedule.tiers?.vip) || !Array.isArray(schedule.tiers?.mm)) {
    throw new Error("Fee schedule is unavailable.");
  }
  return {
    volumeTiers: [
      { minimumVolume: 0, makerRate: number(schedule.add), takerRate: number(schedule.cross) },
      ...schedule.tiers.vip.map((tier) => ({
        minimumVolume: number(tier.ntlCutoff),
        makerRate: number(tier.add),
        takerRate: number(tier.cross),
      })),
    ],
    makerFractionTiers: schedule.tiers.mm.map((tier) => ({
      minimumMakerFraction: number(tier.makerFractionCutoff),
      makerRate: number(tier.add),
    })),
  };
}

export function estimateMarketFill(levels, requestedSize, markPrice, side) {
  const size = positiveNumber(requestedSize);
  const mark = positiveNumber(markPrice);
  if (!size || !mark || !Array.isArray(levels) || !levels.length) return null;
  let remaining = size;
  let filledSize = 0;
  let notional = 0;
  for (const level of levels) {
    const price = positiveNumber(level.px ?? level.price);
    const available = positiveNumber(level.sz ?? level.size);
    if (!price || !available) continue;
    const fill = Math.min(remaining, available);
    filledSize += fill;
    notional += fill * price;
    remaining -= fill;
    if (remaining <= Number.EPSILON) break;
  }
  if (!(filledSize > 0)) return null;
  const averagePrice = notional / filledSize;
  const slippagePercent = side === "sell"
    ? (mark - averagePrice) / mark * 100
    : (averagePrice - mark) / mark * 100;
  return { averagePrice, filledSize, complete: remaining <= Number.EPSILON, slippagePercent };
}

export function estimateIsolatedLiquidationPrice(entryPrice, side, leverage, maxLeverage) {
  const price = positiveNumber(entryPrice);
  const initialLeverage = positiveNumber(leverage);
  const maximum = positiveNumber(maxLeverage);
  if (!price || !initialLeverage || !maximum) return null;
  const direction = side === "sell" ? -1 : 1;
  const maintenanceRate = 1 / (2 * maximum);
  const marginAvailablePerUnit = price / initialLeverage - price * maintenanceRate;
  const estimate = price - direction * marginAvailablePerUnit / (1 - maintenanceRate * direction);
  return estimate > 0 ? estimate : null;
}

export function formatPaperNumber(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function paperSignClass(value) {
  return Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "";
}

export function activePaperEpoch(account, epochs) {
  return epochs.find((epoch) => epoch.account_id === account?.id && epoch.epoch_number === account.active_epoch && epoch.state === "active") ?? null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function maximumOrderSize(availableMargin, leverage, price, marginTiers) {
  if (price === null || leverage === null) return null;
  let low = 0;
  let high = availableMargin * leverage;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const middle = (low + high) / 2;
    if (middle / effectiveLeverage(middle, leverage, marginTiers) <= availableMargin) low = middle;
    else high = middle;
  }
  return low / price;
}

function effectiveLeverage(notional, selectedLeverage, marginTiers) {
  const tiers = [...(marginTiers?.length ? marginTiers : [{ lowerBound: 0, maxLeverage: selectedLeverage }])]
    .sort((left, right) => Number(left.lowerBound) - Number(right.lowerBound));
  let activeTier = tiers[0];
  for (const tier of tiers) {
    if (notional >= Number(tier.lowerBound)) activeTier = tier;
  }
  return Math.min(selectedLeverage, Number(activeTier.maxLeverage));
}
