import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/scaling.js", import.meta.url), "utf8");

test("tools exposes the scaling simulator as a routed subview", () => {
  assert.match(html, /href="#\/tools\/scaling"/);
  assert.match(html, /id="scaling-panel"[^>]*data-tools-panel="scaling"/);
  assert.doesNotMatch(html, /EXPOSURE LADDER|exposure-ladder/);
});

test("scaling view provides risk, lot, level, drawing, and audit controls", () => {
  assert.match(html, /id="scaling-asset-picker"/);
  assert.match(html, /name="maxRisk"/);
  assert.match(html, /name="maxLossMode"/);
  assert.match(html, /name="startingLotMode"/);
  assert.match(html, /id="scaling-ladder-chart"/);
  assert.match(html, /id="scaling-path-chart"/);
  assert.match(html, /data-path-mode="draw"/);
  assert.match(html, /data-path-mode="inspect"/);
  assert.match(html, /id="scaling-events"/);
  assert.match(html, /id="scaling-generation-status"/);
  assert.match(html, /id="scaling-rebase"/);
  assert.match(html, /MAX ALLOCATION/);
});

test("drawing surfaces are touch-safe and use live Hyperliquid marks", () => {
  assert.match(css, /\.scaling-ladder-chart[^}]*touch-action:\s*none/s);
  assert.match(css, /\.scaling-path-chart[^}]*touch-action:\s*none/s);
  assert.match(script, /new WebSocket\(APP_CONFIG\.websocketUrl\)/);
  assert.match(script, /type:\s*"activeAssetCtx"/);
});

test("mobile scaling charts remain responsive instead of forcing a wide drawing surface", () => {
  assert.doesNotMatch(css, /\.scaling-path-chart\s*\{[^}]*width:\s*900px/s);
});

test("regeneration preserves a custom path and the first point is a locked anchor", () => {
  assert.match(script, /if \(!scalingState\.pathPoints\.length\) setPathPreset\("chop", false\)/);
  assert.match(script, /index === 0[\s\S]*scaling-path-point locked/);
  assert.match(script, /scalingSettingsAtAnchor\(scalingState\.appliedSettings, livePrice\)/);
});
