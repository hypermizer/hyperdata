const EPSILON = 1e-9;

function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function nonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} cannot be negative`);
  return number;
}

function feeRateFromBps(value) {
  const feeBps = nonNegative(value ?? 0, "Fee");
  if (feeBps >= 10_000) throw new Error("Fee must be below 10,000 bps");
  return { feeBps, feeRate: feeBps / 10_000 };
}

function normalizeDirection(value) {
  if (value !== "long" && value !== "short") throw new Error("Direction must be long or short");
  return value;
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels) || !levels.length) throw new Error("At least one entry level is required");
  const ids = new Set();
  return levels.map((level, index) => {
    const id = String(level?.id ?? `level-${index + 1}`);
    if (ids.has(id)) throw new Error("Entry level IDs must be unique");
    ids.add(id);
    return {
      id,
      price: positive(level?.price, `Level ${index + 1} price`),
      units: positive(level?.units, `Level ${index + 1} units`),
    };
  });
}

function normalizePath(path) {
  if (!Array.isArray(path) || !path.length) throw new Error("Draw at least one path point");
  return path.map((price, index) => positive(price, `Path point ${index + 1}`));
}

function plannedNotional(levels) {
  return levels.reduce((total, level) => total + level.price * level.units, 0);
}

function closedPlanPnl(direction, levels, stopPrice, feeRate) {
  const notional = plannedNotional(levels);
  const units = levels.reduce((total, level) => total + level.units, 0);
  const entryCash = direction === "long" ? -notional : notional;
  const signedUnits = direction === "long" ? units : -units;
  return entryCash - notional * feeRate + signedUnits * stopPrice - units * stopPrice * feeRate;
}

function levelsAtStop(anchorPrice, stopPrice, units, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `level-${index + 1}`,
    price: anchorPrice + (stopPrice - anchorPrice) * index / count,
    units,
  }));
}

function solveGeneratedStop({ direction, anchorPrice, maxLoss, startingLotUnits, count, feeRate }) {
  const lossAt = (stopPrice) => -closedPlanPnl(
    direction,
    levelsAtStop(anchorPrice, stopPrice, startingLotUnits, count),
    stopPrice,
    feeRate,
  );
  let lower;
  let upper;
  if (direction === "long") {
    lower = anchorPrice * 1e-9;
    upper = anchorPrice;
    if (lossAt(lower) < maxLoss) return null;
  } else {
    lower = anchorPrice;
    upper = anchorPrice * 2;
    while (lossAt(upper) < maxLoss && upper < anchorPrice * 1e9) upper *= 2;
    if (lossAt(upper) < maxLoss) return null;
  }
  if (lossAt(anchorPrice) > maxLoss) return null;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (lossAt(midpoint) > maxLoss) {
      if (direction === "long") lower = midpoint;
      else upper = midpoint;
    } else if (direction === "long") upper = midpoint;
    else lower = midpoint;
  }
  return (lower + upper) / 2;
}

function entrySide(direction) {
  return direction === "long" ? 1 : -1;
}

function closePnlAtPrice(state, price, feeRate) {
  return state.cash + state.position * price - Math.abs(state.position * price) * feeRate;
}

function stopPriceForState(state, maxLoss, feeRate) {
  if (Math.abs(state.position) <= EPSILON) return null;
  const units = Math.abs(state.position);
  const denominator = state.position > 0 ? units * (1 - feeRate) : units * (1 + feeRate);
  const numerator = state.position > 0 ? -maxLoss - state.cash : state.cash + maxLoss;
  const price = numerator / denominator;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function isAhead(price, current, end, movement) {
  return movement > 0
    ? price > current + EPSILON && price <= end + EPSILON
    : price < current - EPSILON && price >= end - EPSILON;
}

function nearestPrice(prices, movement) {
  return movement > 0 ? Math.min(...prices) : Math.max(...prices);
}

function averageEntry(state) {
  return state.units > EPSILON ? state.entryNotional / state.units : null;
}

function snapshot(state, price, feeRate, pathIndex) {
  const pnl = state.position === 0 ? state.cash : state.cash + state.position * price;
  return {
    pathIndex,
    price,
    units: Math.abs(state.position),
    signedUnits: state.position,
    averageEntry: averageEntry(state),
    deployedNotional: state.deployedNotional,
    remainingRisk: state.maxRisk - state.deployedNotional,
    pnl,
    closePnl: state.position === 0 ? state.cash : closePnlAtPrice(state, price, feeRate),
    stopPrice: stopPriceForState(state, state.maxLoss, feeRate),
    fees: state.fees,
  };
}

export function scalingPlanSummary(settings) {
  const direction = normalizeDirection(settings.direction);
  const anchorPrice = positive(settings.anchorPrice, "Anchor price");
  const maxRisk = positive(settings.maxRisk, "Max risk");
  const maxLoss = positive(settings.maxLoss, "Max loss");
  const { feeRate } = feeRateFromBps(settings.feeBps);
  const levels = normalizeLevels(settings.levels);
  const notional = plannedNotional(levels);
  const favorableLevels = levels.filter(({ price }) => direction === "long" ? price > anchorPrice + EPSILON : price < anchorPrice - EPSILON).length;
  const adverseLevels = levels.filter(({ price }) => direction === "long" ? price < anchorPrice - EPSILON : price > anchorPrice + EPSILON).length;
  const anchorLevels = levels.length - favorableLevels - adverseLevels;
  const totalUnits = levels.reduce((total, level) => total + level.units, 0);
  const average = levels.reduce((total, level) => total + level.price * level.units, 0) / totalUnits;
  const entryFees = notional * feeRate;
  const impliedStop = direction === "long"
    ? (totalUnits * average + entryFees - maxLoss) / (totalUnits * (1 - feeRate))
    : (totalUnits * average - entryFees + maxLoss) / (totalUnits * (1 + feeRate));
  const lossAtImpliedStop = impliedStop > 0 ? -closedPlanPnl(direction, levels, impliedStop, feeRate) : null;

  return {
    direction,
    anchorPrice,
    maxRisk,
    maxLoss,
    levels,
    plannedNotional: notional,
    remainingRisk: maxRisk - notional,
    totalUnits,
    averageEntry: average,
    favorableLevels,
    adverseLevels,
    anchorLevels,
    impliedStop: impliedStop > 0 ? impliedStop : null,
    lossAtImpliedStop,
  };
}

export function generateScalingLevels(settings) {
  const direction = normalizeDirection(settings.direction);
  const anchorPrice = positive(settings.anchorPrice, "Anchor price");
  const maxRisk = positive(settings.maxRisk, "Max risk");
  const maxLoss = positive(settings.maxLoss, "Max loss");
  const startingLotUnits = positive(settings.startingLotUnits, "Starting lot");
  const { feeBps, feeRate } = feeRateFromBps(settings.feeBps);
  const requestedCount = Math.max(1, Math.min(50, Math.floor(positive(settings.levelCount ?? 5, "Level count"))));
  let count = requestedCount;
  let levels = [];
  let foundAdverseStop = false;

  while (count >= 1) {
    const stopPrice = solveGeneratedStop({ direction, anchorPrice, maxLoss, startingLotUnits, count, feeRate });
    if (stopPrice === null) {
      count -= 1;
      continue;
    }
    foundAdverseStop = true;
    levels = levelsAtStop(anchorPrice, stopPrice, startingLotUnits, count);
    if (plannedNotional(levels) <= maxRisk + EPSILON) break;
    count -= 1;
  }

  if (!levels.length || plannedNotional(levels) > maxRisk + EPSILON) {
    if (!foundAdverseStop) throw new Error("Max loss is below the generated ladder's round-trip fees");
    throw new Error("Starting lot exceeds max risk");
  }
  if (count !== requestedCount) {
    throw new Error(`${requestedCount} levels do not fit max allocation with this starting lot; maximum is ${count}`);
  }
  return {
    levels,
    summary: scalingPlanSummary({ direction, anchorPrice, maxRisk, maxLoss, feeBps, levels }),
  };
}

export function evenlySpaceScalingLevels(inputLevels, anchorPriceInput) {
  const anchorPrice = positive(anchorPriceInput, "Anchor price");
  const levels = normalizeLevels(inputLevels).map((level) => ({ ...level }));
  const lower = levels.filter(({ price }) => price < anchorPrice - EPSILON).sort((left, right) => left.price - right.price);
  const upper = levels.filter(({ price }) => price > anchorPrice + EPSILON).sort((left, right) => left.price - right.price);
  const anchors = levels.filter(({ price }) => Math.abs(price - anchorPrice) <= EPSILON);
  lower.forEach((level, index) => { level.price = lower[0].price + (anchorPrice - lower[0].price) * index / lower.length; });
  upper.forEach((level, index) => { level.price = anchorPrice + (upper.at(-1).price - anchorPrice) * (index + 1) / upper.length; });
  anchors.forEach((level) => { level.price = anchorPrice; });
  const byId = new Map([...lower, ...anchors, ...upper].map((level) => [level.id, level]));
  return levels.map((level) => byId.get(level.id));
}

export function simulateScalingPath(settings) {
  const direction = normalizeDirection(settings.direction);
  const maxRisk = positive(settings.maxRisk, "Max risk");
  const maxLoss = positive(settings.maxLoss, "Max loss");
  const { feeBps, feeRate } = feeRateFromBps(settings.feeBps);
  const levels = normalizeLevels(settings.levels);
  const path = normalizePath(settings.path);
  const configuredNotional = plannedNotional(levels);
  if (configuredNotional > maxRisk + EPSILON) throw new Error("Configured entries exceed max risk");

  const pending = new Map(levels.map((level) => [level.id, level]));
  const state = {
    cash: 0,
    position: 0,
    units: 0,
    entryNotional: 0,
    deployedNotional: 0,
    fees: 0,
    maxRisk,
    maxLoss,
    stopped: false,
  };
  const events = [];
  const timeline = [];
  const observations = [];

  function recordEvent(type, price, pathIndex, extra = {}) {
    const point = snapshot(state, price, feeRate, pathIndex);
    events.push({ sequence: events.length + 1, type, ...point, ...extra });
    observations.push(point);
  }

  function fill(level, pathIndex) {
    const signedUnits = entrySide(direction) * level.units;
    const notional = level.price * level.units;
    const fee = notional * feeRate;
    state.cash -= signedUnits * level.price + fee;
    state.position += signedUnits;
    state.units += level.units;
    state.entryNotional += notional;
    state.deployedNotional += notional;
    state.fees += fee;
    pending.delete(level.id);
    recordEvent("fill", level.price, pathIndex, {
      levelId: level.id,
      action: direction === "long" ? "BUY" : "SELL",
      fillUnits: level.units,
      fillNotional: notional,
      fee,
    });
  }

  function closeAtStop(price, pathIndex) {
    const closeUnits = Math.abs(state.position);
    const closeNotional = closeUnits * price;
    const fee = closeNotional * feeRate;
    state.cash += state.position * price - fee;
    state.fees += fee;
    state.position = 0;
    state.units = 0;
    state.entryNotional = 0;
    state.stopped = true;
    pending.clear();
    recordEvent("stop", price, pathIndex, {
      action: direction === "long" ? "SELL TO STOP" : "BUY TO STOP",
      fillUnits: closeUnits,
      fillNotional: closeNotional,
      fee,
    });
  }

  function fillAtPrice(price, pathIndex) {
    [...pending.values()]
      .filter((level) => Math.abs(level.price - price) <= EPSILON)
      .sort((left, right) => left.id.localeCompare(right.id))
      .forEach((level) => fill(level, pathIndex));
    if (!state.stopped && Math.abs(state.position) > EPSILON && closePnlAtPrice(state, price, feeRate) <= -maxLoss + EPSILON) {
      closeAtStop(price, pathIndex);
    }
  }

  fillAtPrice(path[0], 0);
  timeline.push(snapshot(state, path[0], feeRate, 0));
  observations.push(timeline.at(-1));

  for (let pathIndex = 1; pathIndex < path.length; pathIndex += 1) {
    const end = path[pathIndex];
    let current = path[pathIndex - 1];
    const movement = Math.sign(end - current);
    if (movement !== 0 && !state.stopped) {
      while (!state.stopped) {
        const entryPrices = [...pending.values()]
          .map(({ price }) => price)
          .filter((price) => isAhead(price, current, end, movement));
        const stopPrice = stopPriceForState(state, maxLoss, feeRate);
        const stopAhead = stopPrice !== null && isAhead(stopPrice, current, end, movement);
        if (!entryPrices.length && !stopAhead) break;
        const entryPrice = entryPrices.length ? nearestPrice(entryPrices, movement) : null;
        const stopFirst = stopAhead && (entryPrice === null || Math.abs(stopPrice - current) <= Math.abs(entryPrice - current) + EPSILON);
        if (stopFirst) {
          closeAtStop(stopPrice, pathIndex);
          break;
        }
        current = entryPrice;
        fillAtPrice(entryPrice, pathIndex);
      }
    }
    timeline.push(snapshot(state, end, feeRate, pathIndex));
    observations.push(timeline.at(-1));
  }

  const ending = timeline.at(-1);
  let peakPnl = observations[0]?.pnl ?? 0;
  let maxDrawdown = 0;
  for (const point of observations) {
    peakPnl = Math.max(peakPnl, point.pnl);
    maxDrawdown = Math.max(maxDrawdown, peakPnl - point.pnl);
  }
  return {
    direction,
    maxRisk,
    maxLoss,
    feeBps,
    levels,
    path,
    events,
    timeline,
    ending,
    stopped: state.stopped,
    totalFees: state.fees,
    maxDrawdown,
    filledLevelIds: events.filter(({ type }) => type === "fill").map(({ levelId }) => levelId),
    pendingLevelIds: [...pending.keys()],
  };
}
