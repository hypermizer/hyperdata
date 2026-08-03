function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function lotUnitsFromDrag(drag, pointerX) {
  const delta = (Number(pointerX) - drag.startPointerX) * drag.unitsPerSvgX;
  return clamp(drag.startUnits + delta, drag.minUnits, drag.maxUnits);
}

export function priceFromDrag(drag, pointerY) {
  const delta = (Number(pointerY) - drag.startPointerY) * drag.pricePerSvgY;
  return clamp(drag.startPrice - delta, drag.minPrice, drag.maxPrice);
}

const GENERATION_SETTING_KEYS = [
  "direction", "maxRisk", "maxLossInput", "maxLossMode", "startingLotInput",
  "startingLotMode", "levelCount", "feeBps",
];

export function scalingSettingsAtAnchor(settings, anchorPriceInput) {
  const anchorPrice = Number(anchorPriceInput);
  const maxRisk = Number(settings.maxRisk);
  const maxLossInput = Number(settings.maxLossInput);
  const startingLotInput = Number(settings.startingLotInput);
  return {
    ...settings,
    maxRisk,
    maxLossInput,
    maxLoss: settings.maxLossMode === "percent" ? maxRisk * maxLossInput / 100 : maxLossInput,
    startingLotInput,
    startingLotUnits: settings.startingLotMode === "shares" ? startingLotInput : startingLotInput / anchorPrice,
    levelCount: Number(settings.levelCount),
    feeBps: Number(settings.feeBps),
    rangePct: Number(settings.rangePct),
    anchorPrice,
  };
}

export function generationSettingsKey(settings) {
  return JSON.stringify(GENERATION_SETTING_KEYS.map((key) => settings?.[key]));
}

export function rebasePathPoints(pathPoints, previousAnchor, nextAnchor) {
  const ratio = Number(nextAnchor) / Number(previousAnchor);
  return pathPoints.map((point, index) => ({
    x: point.x,
    price: index === 0 ? Number(nextAnchor) : point.price * ratio,
  }));
}
