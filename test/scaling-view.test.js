import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/tools.js", import.meta.url), "utf8");

test("tools exposes the scaling simulator as a routed subview", () => {
  assert.match(html, /href="#\/tools\/scaling"/);
  assert.match(html, /id="scaling-panel"[^>]*data-tools-panel="scaling"/);
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
});

test("drawing surfaces are touch-safe and use live Hyperliquid marks", () => {
  assert.match(css, /\.scaling-ladder-chart[^}]*touch-action:\s*none/s);
  assert.match(css, /\.scaling-path-chart[^}]*touch-action:\s*none/s);
  assert.match(script, /new WebSocket\(APP_CONFIG\.websocketUrl\)/);
  assert.match(script, /type:\s*"activeAssetCtx"/);
});
