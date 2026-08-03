import assert from "node:assert/strict";
import test from "node:test";
import {
  generationSettingsKey,
  lotUnitsFromDrag,
  priceFromDrag,
  rebasePathPoints,
  scalingSettingsAtAnchor,
} from "../public/lib/scaling-interactions.js";

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

test("rebasing recomputes dollar lots while preserving raw applied settings", () => {
  const applied = {
    direction: "long", maxRisk: 5_000, maxLossInput: 10, maxLossMode: "percent",
    startingLotInput: 500, startingLotMode: "dollars", levelCount: 8, feeBps: 1, rangePct: 20,
  };
  const rebased = scalingSettingsAtAnchor(applied, 50);

  assert.equal(rebased.startingLotUnits, 10);
  assert.equal(rebased.maxLoss, 500);
  assert.equal(rebased.anchorPrice, 50);
  assert.equal(rebased.startingLotInput, 500);
});

test("dirty comparison tracks generation inputs but ignores derived anchor values", () => {
  const base = scalingSettingsAtAnchor({
    direction: "long", maxRisk: 5_000, maxLossInput: 500, maxLossMode: "dollars",
    startingLotInput: 500, startingLotMode: "dollars", levelCount: 8, feeBps: 0, rangePct: 20,
  }, 100);
  const rebased = scalingSettingsAtAnchor(base, 50);

  assert.equal(generationSettingsKey(base), generationSettingsKey(rebased));
  assert.notEqual(generationSettingsKey(base), generationSettingsKey({ ...base, maxRisk: 6_000 }));
});

test("rebasing a path preserves its relative geometry and locks its start to the new anchor", () => {
  assert.deepEqual(rebasePathPoints([
    { x: 0, price: 100 },
    { x: 0.5, price: 80 },
    { x: 1, price: 120 },
  ], 100, 50), [
    { x: 0, price: 50 },
    { x: 0.5, price: 40 },
    { x: 1, price: 60 },
  ]);
});
