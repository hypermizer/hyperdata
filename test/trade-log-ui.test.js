import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("analysis exposes a routed trade log table and order entry form", () => {
  assert.match(html, /href="#\/analysis\/trade-log"/);
  assert.match(html, /id="trade-log-form"/);
  assert.match(html, /id="trade-log-table"/);
  assert.match(html, /name="side"[^>]*value="buy"/);
  assert.match(html, /name="side"[^>]*value="sell"/);
  assert.match(html, /id="trade-csv-input"[^>]*accept="\.csv,text\/csv"/);
  assert.match(html, /id="trade-csv-upload"[^>]*>UPLOAD FULL CSV</);
  assert.match(html, /id="trade-csv-status"/);
});

test("the strategy product surface and runtime are removed", () => {
  assert.doesNotMatch(html, /data-tab="strats"|id="strats-view"|src="\.\/strats\.js/);
});
