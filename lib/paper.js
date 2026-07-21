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
  const currentMargin = Math.max(0, Number(input.currentMargin) || 0);
  const feeRate = Number(input.feeRate) || 0;
  const validOrder = price !== null && size !== null && leverage !== null;
  const orderValue = validOrder ? size * price : null;
  const direction = input.side === "sell" ? -1 : 1;
  const finalPosition = validOrder ? currentPosition + direction * size : null;
  const finalMargin = finalPosition === null ? null
    : paperInitialMargin(Math.abs(finalPosition) * price, leverage, input.marginTiers);
  const marginRequired = finalMargin === null ? null : input.reduceOnly ? 0
    : Math.max(0, finalMargin - currentMargin);
  const estimatedFee = orderValue === null ? null : orderValue * feeRate;
  const reducesPosition = input.side === "sell" ? currentPosition > 0 : currentPosition < 0;
  const maxSize = input.reduceOnly
    ? (reducesPosition ? Math.abs(currentPosition) : 0)
    : maximumOrderSize(availableMargin, currentMargin, currentPosition, input.side, leverage, price, input.marginTiers, feeRate);
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

export function paperInitialMargin(notional, leverage, marginTiers) {
  const value = Math.max(0, Number(notional) || 0);
  const selectedLeverage = positiveNumber(leverage);
  return selectedLeverage === null ? 0 : value / effectiveLeverage(value, selectedLeverage, marginTiers);
}

export function paperOrderSize(amount, unit, price, sizeDecimals) {
  const value = positiveNumber(amount);
  if (value === null) return null;
  if (unit !== "usdc") return String(amount).trim();
  const referencePrice = positiveNumber(price);
  if (referencePrice === null) return null;
  const decimals = Math.max(0, Math.min(8, Number(sizeDecimals) || 0));
  const scale = 10 ** decimals;
  const rawUnits = value / referencePrice * scale;
  const roundingTolerance = Number.EPSILON * Math.max(1, Math.abs(rawUnits)) * 4;
  const shares = Math.floor(rawUnits + roundingTolerance) / scale;
  return shares > 0 ? shares.toFixed(decimals).replace(/\.?0+$/, "") : null;
}

export function paperPriceValid(value, sizeDecimals) {
  const price = positiveNumber(value);
  if (price === null) return false;
  const text = String(value).trim().toLowerCase();
  const [coefficient, exponentText] = text.split("e");
  const exponent = Number(exponentText || 0);
  const fractionalDigits = (coefficient.split(".")[1] ?? "").length;
  const decimalPlaces = Math.max(0, fractionalDigits - exponent);
  const significantFigures = coefficient.replace(".", "").replace(/^[-+]?0+/, "").replace(/0+$/, "").length;
  return decimalPlaces <= Math.max(0, 6 - Number(sizeDecimals || 0)) && significantFigures <= 5;
}

export function paperOrderReceipt(result) {
  const status = String(result?.response?.status ?? "accepted").toLowerCase();
  const order = result?.order ?? {};
  const fills = Array.isArray(result?.fills) ? result.fills : [];
  const filledSize = fills.reduce((sum, fill) => sum + (Number(fill.size) || 0), 0);
  const filledNotional = fills.reduce((sum, fill) => sum + (Number(fill.size) || 0) * (Number(fill.price) || 0), 0);
  const fee = fills.reduce((sum, fill) => sum + (Number(fill.fee) || 0), 0);
  const asset = String(order.asset ?? "ASSET").replace(/^xyz:/, "");
  const side = order.side === "sell" ? "SHORT" : "LONG";
  const size = compactPaperNumber(filledSize || order.requestedSize || order.size, 8);
  const presentation = {
    filled: { label: "ORDER FILLED", tone: "success" },
    partially_filled: { label: "ORDER PARTIALLY FILLED", tone: "warning" },
    resting: { label: "ORDER RESTING", tone: "success" },
    trigger_waiting: { label: "TRIGGER ORDER ACTIVE", tone: "success" },
    canceled: { label: "ORDER CANCELED", tone: "error" },
    rejected: { label: "ORDER REJECTED", tone: "error" },
  };
  const statusPresentation = status === "canceled" && filledSize > 0
    ? { label: "ORDER PARTIALLY FILLED", tone: "warning" }
    : presentation[status] ?? { label: "ORDER ACCEPTED", tone: "success" };
  let text = `${statusPresentation.label} — ${side} ${size} ${asset}`;
  if (filledSize > 0) text += ` @ $${compactPaperNumber(filledNotional / filledSize, 6)}`;
  if (fee) text += ` · ${fee < 0 ? "REBATE" : "FEE"} $${compactPaperNumber(Math.abs(fee), 6)}`;
  if (result?.response?.reason) text += ` · ${String(result.response.reason).toUpperCase()}`;
  return { tone: statusPresentation.tone, text };
}

export async function resolvePaperCommand(invoke, findStored, options = {}) {
  let response;
  try {
    response = await invoke();
  } catch (error) {
    response = { data: null, error };
  }
  if (!response.error) return { data: response.data, reconciled: false };
  const responseStatus = Number(response.error?.context?.status);
  if (responseStatus >= 400 && responseStatus < 500) throw response.error;
  const attempts = Math.max(1, Number(options.attempts) || 4);
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const delays = options.delays ?? [0, 250, 750, 1_500];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const delay = Number(delays[Math.min(attempt, delays.length - 1)]) || 0;
    if (delay > 0) await wait(delay);
    let stored = null;
    try { stored = await findStored(); } catch { /* Retry while the outcome remains ambiguous. */ }
    if (stored) return { data: stored, reconciled: true };
  }
  const error = new Error(String(response.error?.message ?? response.error));
  error.name = "PaperCommandOutcomeUnknownError";
  error.outcomeUnknown = true;
  error.cause = response.error;
  throw error;
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

export function scalePerpFeeRate(rate, market, liquidity) {
  const base = Number(rate);
  if (!Number.isFinite(base) || !market?.dexId) return base;
  const deployerScale = Number(market.deployerFeeScale);
  const hip3Scale = Number.isFinite(deployerScale)
    ? (deployerScale < 1 ? deployerScale + 1 : deployerScale * 2)
    : 1;
  const growthScale = market.growthMode === "enabled" ? 0.1 : 1;
  return base * growthScale * (liquidity === "maker" && base <= 0 ? 1 : hip3Scale);
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

export function estimateMarketFill(levels, requestedSize, markPrice, side, maxSlippagePercent = null, protectionPrice = markPrice) {
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
    if (Number.isFinite(maxSlippagePercent)) {
      const protection = positiveNumber(protectionPrice) ?? mark;
      const protectedPrice = side === "sell"
        ? protection * (1 - maxSlippagePercent / 100)
        : protection * (1 + maxSlippagePercent / 100);
      if ((side === "sell" && price < protectedPrice) || (side !== "sell" && price > protectedPrice)) break;
    }
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

function compactPaperNumber(value, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toFixed(digits).replace(/\.?0+$/, "");
}

function maximumOrderSize(availableMargin, currentMargin, currentPosition, side, leverage, price, marginTiers, feeRate = 0) {
  if (price === null || leverage === null) return null;
  const capacity = availableMargin + currentMargin;
  const direction = side === "sell" ? -1 : 1;
  const positiveFeeRate = Math.max(0, Number(feeRate) || 0);
  const cost = (size) => {
    const finalNotional = Math.abs(currentPosition + direction * size) * price;
    return paperInitialMargin(finalNotional, leverage, marginTiers) + size * price * positiveFeeRate;
  };
  let low = 0;
  let high = Math.max(1, Math.abs(currentPosition) * 2, capacity * leverage / price * 2);
  for (let expansion = 0; expansion < 32 && cost(high) <= capacity; expansion += 1) high *= 2;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const middle = (low + high) / 2;
    if (cost(middle) <= capacity) low = middle;
    else high = middle;
  }
  return low;
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
