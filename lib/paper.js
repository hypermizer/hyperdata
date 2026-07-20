export function normalizeAccountName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 60) throw new Error("Account name must be 1–60 characters.");
  return name;
}

export function normalizePaperOrder(input) {
  const asset = String(input.asset ?? "").trim();
  const size = String(input.size ?? "").trim();
  const leverage = Number(input.leverage);
  const limitPrice = String(input.limitPrice ?? "").trim() || null;
  const triggerPrice = String(input.triggerPrice ?? "").trim() || null;
  const orderType = String(input.orderType);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(asset)) throw new Error("Enter a valid asset.");
  if (!(Number(size) > 0)) throw new Error("Size must be positive.");
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error("Leverage must be a positive integer.");
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
