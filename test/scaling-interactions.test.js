import assert from "node:assert/strict";
import test from "node:test";
import { lotUnitsFromDrag, priceFromDrag } from "../public/lib/scaling-interactions.js";

test("lot dragging uses the pointer-down value and a frozen linear scale", () => {
  const drag = { startUnits: 10, startPointerX: 250, unitsPerSvgX: 20 / 220, minUnits: 0.1, maxUnits: 20 };

  assert.equal(lotUnitsFromDrag(drag, 251), 10 + 20 / 220);
  assert.equal(lotUnitsFromDrag(drag, 252), 10 + 40 / 220);
  assert.equal(lotUnitsFromDrag(drag, 251), 10 + 20 / 220);
});

test("lot dragging clamps without changing its scale", () => {
  const drag = { startUnits: 10, startPointerX: 250, unitsPerSvgX: 0.1, minUnits: 0.5, maxUnits: 20 };

  assert.equal(lotUnitsFromDrag(drag, -1_000), 0.5);
  assert.equal(lotUnitsFromDrag(drag, 1_000), 20);
});

test("price dragging is relative to pointer-down and inverted on the y axis", () => {
  const drag = { startPrice: 100, startPointerY: 200, pricePerSvgY: 0.5, minPrice: 50, maxPrice: 150 };

  assert.equal(priceFromDrag(drag, 190), 105);
  assert.equal(priceFromDrag(drag, 210), 95);
  assert.equal(priceFromDrag(drag, -1_000), 150);
});
