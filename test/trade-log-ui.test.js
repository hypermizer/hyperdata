import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("analysis exposes continuous account fills, positions, and manual order entry", () => {
  assert.match(html, /href="#\/analysis\/trade-log"/);
  assert.match(html, /id="trade-log-form"/);
  assert.match(html, /id="trade-log-table"/);
  assert.match(html, /name="side"[^>]*value="buy"/);
  assert.match(html, /name="side"[^>]*value="sell"/);
  assert.match(html, /id="trade-account-health"/);
  assert.match(html, /id="trade-account-fills"/);
  assert.match(html, /id="trade-account-positions"/);
  assert.doesNotMatch(html, /UPLOAD FULL CSV/);
});

test("the strategy product surface and runtime are removed", () => {
  assert.doesNotMatch(html, /data-tab="strats"|id="strats-view"|src="\.\/strats\.js/);
});
