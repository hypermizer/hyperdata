const EPSILON = 1e-9;

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function finitePercent(value, label, { allowZero = false, max = 100 } = {}) {
  const number = Number(value);
  const lowerValid = allowZero ? number >= 0 : number > 0;
  if (!Number.isFinite(number) || !lowerValid || number > max) throw new Error(`${label} must be ${allowZero ? "between 0" : "above 0"} and ${max}`);
  return number;
}

function priceAtMove(anchorPrice, direction, adverseMovePct) {
  const sign = direction === "long" ? -1 : 1;
  return anchorPrice * (1 + sign * adverseMovePct / 100);
}

function exposurePct(position, initialPosition) {
  return Math.abs(position / initialPosition) * 100;
}

export function simulateExposureLadder(settings) {
  const direction = settings.direction;
  if (direction !== "long" && direction !== "short") throw new Error("Direction must be long or short");
  const trancheBasis = settings.trancheBasis;
  if (trancheBasis !== "original" && trancheBasis !== "remaining") throw new Error("Tranche basis must be original or remaining");

  const anchorPrice = finitePositive(settings.anchorPrice, "Anchor price");
  const initialUnits = finitePositive(settings.initialUnits, "Initial units");
  const adverseStepPct = finitePercent(settings.adverseStepPct, "Adverse step");
  const tranchePct = finitePercent(settings.tranchePct, "Tranche");
  const maxReductionPct = finitePercent(settings.maxReductionPct, "Maximum reduction", { allowZero: true });
  const adverseMovePct = finitePercent(settings.adverseMovePct, "Adverse move", { allowZero: true, max: 99 });
  const recoveryPct = finitePercent(settings.recoveryPct, "Recovery", { allowZero: true });
  const reentryStepPct = finitePercent(settings.reentryStepPct, "Re-entry step");
  const feeBps = finitePercent(settings.feeBps ?? 0, "Fee", { allowZero: true, max: 1_000 });

  const initialPosition = direction === "long" ? initialUnits : -initialUnits;
  let position = initialPosition;
  let cash = -initialPosition * anchorPrice;
  let totalFees = 0;
  let reducedUnits = 0;
  const maximumReductionUnits = initialUnits * maxReductionPct / 100;
  const openTranches = [];
  const scaleOutEvents = [];
  const reentryEvents = [];
  const path = [{ stage: "start", price: anchorPrice, movePct: 0, exposurePct: 100 }];

  function trade(deltaUnits, price) {
    const fee = Math.abs(deltaUnits * price) * feeBps / 10_000;
    cash -= deltaUnits * price + fee;
    position += deltaUnits;
    totalFees += fee;
    return fee;
  }

  for (let index = 1; index * adverseStepPct <= adverseMovePct + EPSILON && reducedUnits < maximumReductionUnits - EPSILON; index += 1) {
    const movePct = index * adverseStepPct;
    const price = priceAtMove(anchorPrice, direction, movePct);
    const requestedUnits = trancheBasis === "original" ? initialUnits * tranchePct / 100 : Math.abs(position) * tranchePct / 100;
    const units = Math.min(requestedUnits, maximumReductionUnits - reducedUnits, Math.abs(position));
    if (units <= EPSILON) break;
    const deltaUnits = direction === "long" ? -units : units;
    const fee = trade(deltaUnits, price);
    reducedUnits += units;
    const tranche = { index, units, scaleOutPrice: price, scaleOutMovePct: movePct };
    openTranches.push(tranche);
    const event = {
      leg: "adverse",
      action: direction === "long" ? "SELL" : "BUY TO COVER",
      price,
      movePct,
      units,
      fee,
      exposurePct: exposurePct(position, initialPosition),
    };
    scaleOutEvents.push(event);
    path.push({ stage: "scale-out", price, movePct, exposurePct: event.exposurePct });
  }

  const turnPrice = priceAtMove(anchorPrice, direction, adverseMovePct);
  const turnExposurePct = exposurePct(position, initialPosition);
  if (Math.abs(path.at(-1).price - turnPrice) > EPSILON) {
    path.push({ stage: "turn", price: turnPrice, movePct: adverseMovePct, exposurePct: turnExposurePct });
  } else {
    path.at(-1).stage = "turn";
  }

  const recoveredMovePct = adverseMovePct * recoveryPct / 100;
  for (let index = 1; index * reentryStepPct <= recoveredMovePct + EPSILON && openTranches.length; index += 1) {
    const movePct = Math.max(0, adverseMovePct - index * reentryStepPct);
    const price = priceAtMove(anchorPrice, direction, movePct);
    const tranche = openTranches.pop();
    const deltaUnits = direction === "long" ? tranche.units : -tranche.units;
    const fee = trade(deltaUnits, price);
    reducedUnits -= tranche.units;
    const event = {
      leg: "recovery",
      action: direction === "long" ? "BUY BACK" : "RE-SELL",
      price,
      movePct,
      units: tranche.units,
      fee,
      exposurePct: exposurePct(position, initialPosition),
      originalScaleOutPrice: tranche.scaleOutPrice,
    };
    reentryEvents.push(event);
    path.push({ stage: "re-entry", price, movePct, exposurePct: event.exposurePct });
  }

  const finalAdverseMovePct = adverseMovePct - recoveredMovePct;
  const finalPrice = priceAtMove(anchorPrice, direction, finalAdverseMovePct);
  const endExposurePct = exposurePct(position, initialPosition);
  if (path.at(-1).stage === "turn" || Math.abs(path.at(-1).price - finalPrice) > EPSILON) {
    path.push({ stage: "end", price: finalPrice, movePct: finalAdverseMovePct, exposurePct: endExposurePct });
  } else {
    path.at(-1).stage = "end";
  }

  const strategyPnl = cash + position * finalPrice;
  const buyAndHoldPnl = initialPosition * (finalPrice - anchorPrice);
  return {
    direction,
    anchorPrice,
    initialUnits,
    finalPrice,
    turnPrice,
    turnExposurePct,
    endExposurePct,
    strategyPnl,
    buyAndHoldPnl,
    scalingEffect: strategyPnl - buyAndHoldPnl,
    totalFees,
    scaleOutEvents,
    reentryEvents,
    events: [...scaleOutEvents, ...reentryEvents],
    path,
  };
}
