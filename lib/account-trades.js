function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`INVALID ${field.toUpperCase()}`);
  return number;
}

export function normalizeAccountFill(row) {
  const size = finite(row.size, "fill size");
  const price = finite(row.price, "fill price");
  return {
    tradeId: String(row.trade_id), asset: String(row.asset), side: String(row.side), direction: String(row.direction),
    size, price, value: size * price,
    closedPnl: finite(row.closed_pnl ?? 0, "closed pnl"), fee: finite(row.fee ?? 0, "fee"),
    feeToken: row.fee_token ? String(row.fee_token) : "", occurredAt: String(row.occurred_at),
    startPosition: row.start_position == null ? null : finite(row.start_position, "start position"),
    orderId: String(row.order_id), transactionHash: row.transaction_hash ? String(row.transaction_hash) : "",
  };
}

export async function fetchAllAccountFills(fetchPage, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1);
    if (result.error) return { data: null, error: result.error };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}

const POSITION_EPSILON = 1e-12;

function positionSign(value) {
  if (Math.abs(value) <= POSITION_EPSILON) return 0;
  return value > 0 ? 1 : -1;
}

function directionName(sign) {
  return sign > 0 ? "long" : "short";
}

function assetName(asset) {
  return String(asset).split(":").at(-1).toUpperCase();
}

function startEpisode(fill, sign, partialHistory = false) {
  const direction = directionName(sign);
  return {
    positionKey: `${fill.asset}|${direction}|${fill.tradeId}`,
    asset: fill.asset,
    direction,
    label: `${direction.toUpperCase()} ${assetName(fill.asset)}`,
    openedAt: fill.occurredAt,
    updatedAt: fill.occurredAt,
    closedAt: null,
    status: "open",
    currentSize: 0,
    closedPnl: 0,
    fees: 0,
    partialHistory,
    fills: [],
  };
}

function addFill(episode, fill, endPosition) {
  episode.fills.push(fill);
  episode.updatedAt = fill.occurredAt;
  episode.currentSize = Math.abs(endPosition);
  episode.closedPnl += fill.closedPnl;
  episode.fees += fill.fee;
  if (positionSign(endPosition) === 0) {
    episode.status = "closed";
    episode.closedAt = fill.occurredAt;
  }
}

function splitFill(fill, size, totalSize, splitPart, direction) {
  const ratio = totalSize ? size / totalSize : 0;
  return {
    ...fill,
    size,
    value: size * fill.price,
    fee: fill.fee * ratio,
    closedPnl: splitPart === "close" ? fill.closedPnl : 0,
    direction,
    splitPart,
  };
}

function orderKey(fill) {
  return `${fill.asset}|${fill.orderId}`;
}

function enrichOrderTotals(fills) {
  const totals = new Map();
  for (const fill of fills) {
    const key = orderKey(fill);
    const total = totals.get(key) ?? { size: 0, value: 0, fee: 0, closedPnl: 0, fillCount: 0 };
    total.size += fill.size;
    total.value += fill.value;
    total.fee += fill.fee;
    total.closedPnl += fill.closedPnl;
    total.fillCount += 1;
    totals.set(key, total);
  }
  return fills.map((fill) => {
    const total = totals.get(orderKey(fill));
    return {
      ...fill,
      orderSize: total.size,
      orderValue: total.value,
      orderPrice: total.size ? total.value / total.size : fill.price,
      orderFee: total.fee,
      orderClosedPnl: total.closedPnl,
      orderFillCount: total.fillCount,
    };
  });
}

function compareFillSequence(left, right) {
  const time = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (time) return time;
  const asset = left.asset.localeCompare(right.asset);
  if (asset) return asset;
  if (left.startPosition !== null && right.startPosition !== null) {
    const leftEnd = left.startPosition + (left.side === "buy" ? left.size : -left.size);
    const rightEnd = right.startPosition + (right.side === "buy" ? right.size : -right.size);
    if (Math.abs(leftEnd - right.startPosition) <= POSITION_EPSILON) return -1;
    if (Math.abs(rightEnd - left.startPosition) <= POSITION_EPSILON) return 1;
  }
  if (left.side === right.side && left.startPosition !== null && right.startPosition !== null) {
    const position = left.side === "buy"
      ? left.startPosition - right.startPosition
      : right.startPosition - left.startPosition;
    if (Math.abs(position) > POSITION_EPSILON) return position;
  }
  const order = String(left.orderId).localeCompare(String(right.orderId), undefined, { numeric: true });
  return order || String(left.tradeId).localeCompare(String(right.tradeId), undefined, { numeric: true });
}

export function aggregateEpisodeOrders(episode) {
  const orders = new Map();
  for (const fill of episode?.fills ?? []) {
    const key = orderKey(fill);
    const order = orders.get(key) ?? {
      orderId: fill.orderId,
      occurredAt: fill.occurredAt,
      side: fill.side,
      directions: new Set(),
      size: fill.orderSize ?? 0,
      episodeSize: 0,
      price: fill.orderPrice ?? 0,
      value: fill.orderValue ?? 0,
      closedPnl: 0,
      fee: 0,
      fillCount: fill.orderFillCount ?? 0,
    };
    order.directions.add(fill.direction);
    order.episodeSize += fill.size;
    order.closedPnl += fill.closedPnl;
    order.fee += fill.fee;
    orders.set(key, order);
  }
  return [...orders.values()].map(({ directions, ...order }) => ({
    ...order,
    direction: directions.size === 1 ? [...directions][0] : "Mixed",
  }));
}

export function episodeExecutionMetrics(episode) {
  const entries = (episode?.fills ?? []).filter((fill) => (
    fill.splitPart === "open"
    || (episode.direction === "long" ? fill.side === "buy" : fill.side === "sell")
  ));
  const totals = entries.reduce((result, fill) => {
    result.shares += fill.size;
    result.notional += fill.value;
    return result;
  }, { shares: 0, notional: 0 });
  return {
    shares: totals.shares,
    averagePrice: totals.shares ? totals.notional / totals.shares : null,
    notional: totals.shares ? totals.notional : null,
  };
}

export function summarizeTradePerformance(episodes) {
  const completed = (episodes ?? [])
    .filter((episode) => episode.status === "closed" && !episode.partialHistory)
    .map((episode) => episode.closedPnl - episode.fees);
  const gains = completed.filter((pnl) => pnl > POSITION_EPSILON);
  const losses = completed.filter((pnl) => pnl < -POSITION_EPSILON);
  const average = (values) => values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
  return {
    winningTrades: gains.length,
    losingTrades: losses.length,
    averageGain: average(gains),
    averageLoss: average(losses),
  };
}

export function buildPositionEpisodes(fills) {
  const ordered = enrichOrderTotals(fills).sort(compareFillSequence);
  const episodes = [];
  const activeByAsset = new Map();
  const trackedPosition = new Map();

  for (const fill of ordered) {
    const inferredStart = trackedPosition.get(fill.asset) ?? 0;
    const start = fill.startPosition ?? inferredStart;
    const delta = (fill.side === "buy" ? 1 : -1) * fill.size;
    const end = start + delta;
    const startSign = positionSign(start);
    const endSign = positionSign(end);
    let active = activeByAsset.get(fill.asset);

    if (active && startSign && active.direction !== directionName(startSign)) {
      active.status = "incomplete";
      active = null;
      activeByAsset.delete(fill.asset);
    }

    if (!active && startSign) {
      active = startEpisode(fill, startSign, true);
      episodes.push(active);
      activeByAsset.set(fill.asset, active);
    }

    if (startSign && endSign && startSign !== endSign) {
      const closingSize = Math.abs(start);
      const openingSize = Math.abs(end);
      addFill(active, splitFill(fill, closingSize, fill.size, "close", `Close ${directionName(startSign)}`), 0);
      activeByAsset.delete(fill.asset);
      const next = startEpisode(fill, endSign);
      addFill(next, splitFill(fill, openingSize, fill.size, "open", `Open ${directionName(endSign)}`), end);
      episodes.push(next);
      activeByAsset.set(fill.asset, next);
      trackedPosition.set(fill.asset, end);
      continue;
    }

    if (!active && endSign) {
      active = startEpisode(fill, endSign);
      episodes.push(active);
      activeByAsset.set(fill.asset, active);
    }

    if (active) {
      addFill(active, fill, end);
      if (!endSign) activeByAsset.delete(fill.asset);
    }
    trackedPosition.set(fill.asset, end);
  }

  const creationOrder = new Map(episodes.map((episode, index) => [episode, index]));
  return episodes.sort((left, right) => (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || creationOrder.get(right) - creationOrder.get(left)
  ));
}

export function formatTradeTimestamp(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit", day: "2-digit", year: "2-digit", hour: "numeric", minute: "2-digit", hour12: true,
    ...(timeZone ? { timeZone } : {}),
  }).format(date).replace(",", "").replace(/\s+(AM|PM)$/, "$1");
}

function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}S AGO`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}M AGO`;
  return `${Math.floor(minutes / 60)}H AGO`;
}

export function accountSyncHealth(source, now = Date.now()) {
  if (source?.last_error) return { label: `SYNC ERROR · ${String(source.last_error).toUpperCase()}`, tone: "error" };
  if (!source?.last_success_at) return { label: "AWAITING FIRST SYNC", tone: "warning" };
  const age = now - Date.parse(source.last_success_at);
  if (!Number.isFinite(age)) return { label: "SYNC TIME INVALID", tone: "error" };
  return { label: `${age <= 150_000 ? "LIVE" : "STALE"} · ${elapsedLabel(age)}`, tone: age <= 150_000 ? "live" : "warning" };
}
