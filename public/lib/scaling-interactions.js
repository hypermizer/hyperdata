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
