import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../public/trade-log.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("analysis exposes continuous account fills, positions, and manual order entry", () => {
  assert.match(html, /href="#\/analysis\/trade-log"/);
  assert.match(html, /id="trade-log-form"/);
  assert.match(html, /id="trade-log-table"/);
  assert.match(html, /name="side"[^>]*value="buy"/);
  assert.match(html, /name="side"[^>]*value="sell"/);
  assert.match(html, /id="trade-account-health"/);
  assert.match(html, /id="trade-account-fills"/);
  assert.match(html, /id="trade-account-positions"/);
  assert.match(html, /id="trade-account-stats"/);
  assert.doesNotMatch(html, /UPLOAD FULL CSV/);
});

test("account fills render as expandable position roots with persistent tags", () => {
  assert.match(script, /buildPositionEpisodes/);
  assert.match(script, /aggregateEpisodeOrders/);
  assert.match(script, /episodeExecutionMetrics/);
  assert.match(script, /summarizeTradePerformance/);
  assert.match(script, /data-position-toggle/);
  assert.match(script, /role="button" aria-expanded/);
  assert.match(script, /closest\("button, a, input, select, textarea"\)/);
  assert.doesNotMatch(script, /trade-position-toggle/);
  assert.match(script, /data-position-tag/);
  assert.match(script, /data-position-tag-editor/);
  assert.match(script, /hyperliquid_account_position_tags/);
  assert.match(script, /EARNINGS.*MEANREV.*YOLO/s);
  assert.match(script, /FILLS COMBINED/);
  assert.match(script, /tagVersion/);
  assert.match(script, /snapshotVersion === state\.tagVersion/);
  assert.match(styles, /trade-position-root/);
  assert.match(styles, /trade-position-fill/);
  assert.match(styles, /trade-position-tag-editor/);
  assert.match(styles, /min-width:\s*940px/);
  assert.match(styles, /trade-performance-stats/);
});

test("the strategy product surface and runtime are removed", () => {
  assert.doesNotMatch(html, /data-tab="strats"|id="strats-view"|src="\.\/strats\.js/);
});
