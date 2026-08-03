import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("assets controls omit the legacy sorting dropdown", () => {
  assert.doesNotMatch(html, /id="asset-sort"/);
});

test("asset controls put category tabs left and icon-only watched/search controls right", () => {
  assert.match(html, /class="asset-category-tabs"[\s\S]*data-asset-category="all"[\s\S]*data-asset-category="equities"[\s\S]*data-asset-category="etfs"[\s\S]*data-asset-category="commodities"[\s\S]*data-asset-category="fx"[\s\S]*data-asset-category="indices"[\s\S]*data-asset-category="pre-ipo"[\s\S]*data-asset-category="other"/);
  assert.match(html, /class="asset-control-actions"[\s\S]*class="watched-first"[^>]*aria-label="Watched assets first"[\s\S]*id="watched-first"[\s\S]*id="asset-filter"/);
  assert.doesNotMatch(html, /WATCHED FIRST/);
});

test("asset stars are positioned outside the name flow", () => {
  assert.match(css, /\.asset-name\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.watch-button\s*\{[^}]*position:\s*absolute[^}]*right:\s*100%/s);
});

test("asset details use native routes with a vendored interactive chart", () => {
  assert.match(html, /id="asset-view"/);
  assert.match(html, /id="asset-chart"/);
  assert.match(html, /lightweight-charts\.standalone\.production\.js\?v=5\.2\.0/);
  assert.match(html, /id="asset-hyperliquid-link"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /id="asset-intervals"/);
  assert.match(html, /id="asset-bar-readout"/);
  assert.match(html, /id="asset-news-list"/);
  assert.match(html, /id="asset-tabs"/);
  assert.match(html, /data-asset-panel="overview"/);
  assert.match(html, /data-asset-panel="news"/);
  assert.match(html, /data-asset-panel="financials"/);
  assert.match(html, /id="asset-company-profile"/);
  assert.match(html, /id="asset-financials-content"/);
});
