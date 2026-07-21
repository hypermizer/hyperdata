import assert from "node:assert/strict";
import test from "node:test";
import { simulateExposureLadder } from "../public/lib/exposure-ladder.js";

const base = {
  direction: "long",
  anchorPrice: 100,
  initialUnits: 100,
  adverseStepPct: 10,
  tranchePct: 10,
  maxReductionPct: 100,
  adverseMovePct: 50,
  recoveryPct: 100,
  reentryStepPct: 10,
  trancheBasis: "original",
  feeBps: 0,
};

test("long ladder scales out on the decline and restores on the recovery", () => {
  const result = simulateExposureLadder(base);

  assert.equal(result.scaleOutEvents.length, 5);
  assert.equal(result.reentryEvents.length, 5);
  assert.equal(result.turnExposurePct, 50);
  assert.equal(result.endExposurePct, 100);
  assert.equal(result.finalPrice, 100);
  assert.equal(result.strategyPnl, -500);
  assert.equal(result.buyAndHoldPnl, 0);
  assert.equal(result.scalingEffect, -500);
  assert.deepEqual(
    result.scaleOutEvents.map(({ price, units }) => [price, units]),
    [[90, 10], [80, 10], [70, 10], [60, 10], [50, 10]],
  );
  assert.deepEqual(result.reentryEvents.map(({ price }) => price), [60, 70, 80, 90, 100]);
});

test("short ladder mirrors the long ladder", () => {
  const result = simulateExposureLadder({ ...base, direction: "short" });

  assert.deepEqual(result.scaleOutEvents.map(({ price }) => Math.round(price)), [110, 120, 130, 140, 150]);
  assert.deepEqual(result.reentryEvents.map(({ price }) => Math.round(price)), [140, 130, 120, 110, 100]);
  assert.equal(result.turnExposurePct, 50);
  assert.equal(result.endExposurePct, 100);
  assert.equal(result.strategyPnl, -500);
});

test("remaining-position tranches compound and partial recovery restores only crossed steps", () => {
  const result = simulateExposureLadder({
    ...base,
    trancheBasis: "remaining",
    recoveryPct: 40,
  });

  assert.equal(result.scaleOutEvents.length, 5);
  assert.equal(result.reentryEvents.length, 2);
  assert.ok(Math.abs(result.turnExposurePct - 59.049) < 1e-9);
  assert.ok(Math.abs(result.endExposurePct - 72.9) < 1e-9);
  assert.equal(result.finalPrice, 70);
});

test("maximum reduction caps scale-out quantity and fees reduce results", () => {
  const withoutFees = simulateExposureLadder({ ...base, maxReductionPct: 30 });
  const withFees = simulateExposureLadder({ ...base, maxReductionPct: 30, feeBps: 5 });

  assert.equal(withoutFees.scaleOutEvents.length, 3);
  assert.equal(withoutFees.turnExposurePct, 70);
  assert.equal(withoutFees.endExposurePct, 100);
  assert.ok(withFees.totalFees > 0);
  assert.ok(withFees.strategyPnl < withoutFees.strategyPnl);
});

test("a zero-recovery path keeps the turning point distinct from the end", () => {
  const result = simulateExposureLadder({ ...base, recoveryPct: 0 });

  assert.equal(result.path.at(-2).stage, "turn");
  assert.equal(result.path.at(-1).stage, "end");
  assert.equal(result.path.at(-2).price, result.path.at(-1).price);
});

test("invalid settings are rejected", () => {
  assert.throws(() => simulateExposureLadder({ ...base, anchorPrice: 0 }), /anchor price/i);
  assert.throws(() => simulateExposureLadder({ ...base, direction: "sideways" }), /direction/i);
});
