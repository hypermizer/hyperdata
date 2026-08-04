import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/levels.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("tools exposes a routed levels workspace", () => {
  assert.match(html, /href="#\/tools\/levels"/);
  assert.match(html, /id="levels-panel"[^>]*data-tools-panel="levels"/);
  assert.match(html, /id="levels-asset-picker"/);
  assert.match(html, /id="levels-chart"/);
  assert.match(html, /id="levels-table"/);
  assert.match(html, /id="levels-setups"/);
});

test("level workspace uses closed-bar analysis, a candle stream, exports, and preferences", () => {
  assert.match(script, /splitLevelCandles/);
  assert.match(script, /type: "candle"/);
  assert.match(script, /analyzeLevels/);
  assert.match(script, /downloadCsv/);
  assert.match(script, /level_tool_preferences/);
  assert.match(script, /if \(routeIsActive\(\)\) \{ connectStream\(\); loadHistory\(\); \}/);
  assert.match(script, /WebSocket\.CONNECTING/);
  assert.match(css, /\.levels-chart/);
});
