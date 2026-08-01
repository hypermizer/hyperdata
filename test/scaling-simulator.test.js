import assert from "node:assert/strict";
import test from "node:test";
import {
  evenlySpaceScalingLevels,
  generateScalingLevels,
  simulateScalingPath,
  scalingPlanSummary,
} from "../public/lib/scaling-simulator.js";

test("generates an evenly spaced adverse ladder within max risk", () => {
  const plan = generateScalingLevels({
    direction: "long",
    anchorPrice: 100,
    maxRisk: 1_000,
    maxLoss: 100,
    startingLotUnits: 2,
    levelCount: 5,
  });

  assert.equal(plan.levels.length, 5);
  assert.equal(plan.levels[0].price, 100);
  assert.ok(plan.levels.every((level, index) => index === 0 || level.price < plan.levels[index - 1].price));
  assert.ok(plan.summary.plannedNotional <= 1_000);
  assert.ok(Math.abs(plan.summary.lossAtImpliedStop - 100) < 1e-6);
});

test("generated stops include entry and exit fees", () => {
  const plan = generateScalingLevels({
    direction: "long",
    anchorPrice: 100,
    maxRisk: 2_000,
    maxLoss: 100,
    startingLotUnits: 2,
    levelCount: 5,
    feeBps: 10,
  });
  const result = simulateScalingPath({
    direction: "long",
    maxRisk: 2_000,
    maxLoss: 100,
    feeBps: 10,
    levels: plan.levels,
    path: [100, plan.summary.impliedStop],
  });

  assert.equal(result.filledLevelIds.length, 5);
  assert.ok(Math.abs(result.ending.pnl + 100) < 1e-7);
});

test("fills every crossed level in physical order and never refills it", () => {
  const result = simulateScalingPath({
    direction: "long",
    maxRisk: 2_000,
    maxLoss: 1_000,
    levels: [
      { id: "start", price: 100, units: 2 },
      { id: "lower", price: 90, units: 2 },
      { id: "upper", price: 110, units: 1 },
    ],
    path: [100, 85, 115, 80, 100],
  });

  assert.deepEqual(result.events.filter(({ type }) => type === "fill").map(({ levelId }) => levelId), ["start", "lower", "upper"]);
  assert.equal(result.events.filter(({ levelId }) => levelId === "lower").length, 1);
  assert.equal(result.ending.units, 5);
  assert.equal(result.ending.averageEntry, 98);
  assert.equal(result.ending.pnl, 10);
});

test("a long hard stop closes at the exact configured cash loss", () => {
  const result = simulateScalingPath({
    direction: "long",
    maxRisk: 2_000,
    maxLoss: 100,
    levels: [
      { id: "start", price: 100, units: 5 },
      { id: "add", price: 90, units: 5 },
    ],
    path: [100, 80, 120],
  });

  const stop = result.events.find(({ type }) => type === "stop");
  assert.ok(stop);
  assert.equal(stop.price, 85);
  assert.ok(Math.abs(stop.pnl + 100) < 1e-9);
  assert.equal(result.ending.units, 0);
  assert.equal(result.ending.pnl, -100);
  assert.equal(result.stopped, true);
});

test("short entries and stop mechanics mirror long positions", () => {
  const result = simulateScalingPath({
    direction: "short",
    maxRisk: 2_000,
    maxLoss: 100,
    levels: [
      { id: "start", price: 100, units: 5 },
      { id: "add", price: 110, units: 5 },
    ],
    path: [100, 120],
  });

  assert.deepEqual(result.events.filter(({ type }) => type === "fill").map(({ price }) => price), [100, 110]);
  assert.equal(result.events.find(({ type }) => type === "stop").price, 115);
  assert.equal(result.ending.pnl, -100);
});

test("fees are included in running pnl and the hard-loss boundary", () => {
  const result = simulateScalingPath({
    direction: "long",
    maxRisk: 1_000,
    maxLoss: 25,
    feeBps: 10,
    levels: [{ id: "start", price: 100, units: 5 }],
    path: [100, 90],
  });

  const fill = result.events.find(({ type }) => type === "fill");
  const stop = result.events.find(({ type }) => type === "stop");
  assert.equal(fill.fee, 0.5);
  assert.ok(Math.abs(stop.price - 95.1951951951952) < 1e-9);
  assert.ok(Math.abs(result.ending.pnl + 25) < 1e-9);
});

test("max drawdown includes fills crossed between drawn vertices", () => {
  const result = simulateScalingPath({
    direction: "long",
    maxRisk: 1_000,
    maxLoss: 500,
    feeBps: 100,
    levels: [{ id: "add", price: 90, units: 1 }],
    path: [80, 120],
  });

  assert.ok(Math.abs(result.maxDrawdown - 0.9) < 1e-9);
});

test("closes immediately when round-trip fees already breach max loss", () => {
  const result = simulateScalingPath({
    direction: "long",
    maxRisk: 1_000,
    maxLoss: 0.5,
    feeBps: 100,
    levels: [{ id: "start", price: 100, units: 1 }],
    path: [100, 110],
  });

  assert.equal(result.stopped, true);
  assert.equal(result.events.at(-1).type, "stop");
  assert.equal(result.events.at(-1).price, 100);
  assert.equal(result.ending.pnl, -2);
});

test("rejects a configured ladder whose notional exceeds max risk", () => {
  assert.throws(() => simulateScalingPath({
    direction: "long",
    maxRisk: 100,
    maxLoss: 50,
    levels: [{ id: "too-large", price: 100, units: 2 }],
    path: [100, 110],
  }), /max risk/i);
});

test("summarizes favorable and adverse levels relative to side", () => {
  const summary = scalingPlanSummary({
    direction: "short",
    anchorPrice: 100,
    maxRisk: 1_000,
    maxLoss: 100,
    levels: [
      { id: "below", price: 90, units: 1 },
      { id: "at", price: 100, units: 1 },
      { id: "above", price: 110, units: 1 },
    ],
  });

  assert.equal(summary.favorableLevels, 1);
  assert.equal(summary.adverseLevels, 1);
  assert.equal(summary.anchorLevels, 1);
  assert.equal(summary.plannedNotional, 300);
});

test("even spacing preserves levels on both sides of the anchor", () => {
  const levels = evenlySpaceScalingLevels([
    { id: "low-far", price: 80, units: 1 },
    { id: "low-near", price: 93, units: 1 },
    { id: "anchor", price: 100, units: 1 },
    { id: "high-near", price: 104, units: 1 },
    { id: "high-far", price: 130, units: 1 },
  ], 100);

  assert.deepEqual(levels.map(({ price }) => price), [80, 90, 100, 115, 130]);
});
