const SHARE_EPSILON = 1e-9;
const TRADE_SIDES = new Set(["buy", "sell"]);

export function normalizeTradeOrder(input) {
  const asset = normalizeAsset(input.asset);
  const side = String(input.side ?? "").trim().toLowerCase();
  const shares = Number(input.shares);
  const price = Number(input.price);
  const executedAt = new Date(input.executedAt);
  const note = String(input.note ?? "").trim();

  if (!asset) throw new Error("Asset is required.");
  if (!TRADE_SIDES.has(side)) throw new Error("Side must be buy or sell.");
  if (!Number.isFinite(shares) || shares <= 0) throw new Error("Shares must be positive.");
  if (!Number.isFinite(price) || price <= 0) throw new Error("Price must be positive.");
  if (!Number.isFinite(executedAt.getTime())) throw new Error("Execution time is invalid.");
  if (note.length > 500) throw new Error("Note must be 500 characters or fewer.");

  return { asset, side, shares, price, executedAt: executedAt.toISOString(), note };
}

export function buildTradeLedger(orders) {
  const positions = new Map();
  return [...orders]
    .sort(compareOrders)
    .map((order) => {
      const shares = Number(order.shares);
      const price = Number(order.price);
      if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0) {
        throw new Error("Trade log contains an invalid order.");
      }
      const side = String(order.side).toLowerCase();
      if (!TRADE_SIDES.has(side)) throw new Error("Trade log contains an invalid side.");
      const asset = normalizeAsset(order.asset);
      const position = positions.get(asset) ?? { shares: 0, positionNumber: 0 };
      if (side === "buy" && position.shares <= SHARE_EPSILON) position.positionNumber += 1;
      if (side === "sell" && shares - position.shares > SHARE_EPSILON) {
        throw new Error(`${asset} sell of ${shares} shares exceeds the ${position.shares} shares held.`);
      }
      position.shares += side === "buy" ? shares : -shares;
      if (Math.abs(position.shares) <= SHARE_EPSILON) position.shares = 0;
      positions.set(asset, position);
      return {
        ...order,
        asset,
        side,
        shares,
        price,
        orderValue: shares * price,
        positionNumber: position.positionNumber,
        sharesAfter: position.shares,
        status: position.shares === 0 ? "closed" : "open",
      };
    });
}

function compareOrders(left, right) {
  const executedDifference = Date.parse(left.executed_at) - Date.parse(right.executed_at);
  if (executedDifference) return executedDifference;
  const createdDifference = Date.parse(left.created_at ?? left.executed_at) - Date.parse(right.created_at ?? right.executed_at);
  if (createdDifference) return createdDifference;
  return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function normalizeAsset(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const separator = raw.indexOf(":");
  if (separator < 0) return raw.toUpperCase();
  return `${raw.slice(0, separator).toLowerCase()}:${raw.slice(separator + 1).toUpperCase()}`;
}
