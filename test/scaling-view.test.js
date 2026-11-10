import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/scaling.js", import.meta.url), "utf8");

test("scaling tools are removed from the app", () => {
  assert.doesNotMatch(html, /data-tab="tools"|id="scaling-panel"|src=".\/scaling.js/);
});

test("drawing surfaces are touch-safe and use live Hyperliquid marks", () => {
  assert.match(css, /\.scaling-ladder-chart[^}]*touch-action:\s*none/s);
  assert.match(css, /\.scaling-path-chart[^}]*touch-action:\s*none/s);
  assert.match(script, /new WebSocket\(APP_CONFIG\.websocketUrl\)/);
  assert.match(script, /type:\s*"activeAssetCtx"/);
});
