import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("assets controls omit the legacy sorting dropdown", () => {
  assert.doesNotMatch(html, /id="asset-sort"/);
});

test("asset stars are positioned outside the name flow", () => {
  assert.match(css, /\.asset-name\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.watch-button\s*\{[^}]*position:\s*absolute[^}]*right:\s*100%/s);
});
