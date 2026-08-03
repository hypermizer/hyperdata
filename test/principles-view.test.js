import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("principles is a far-right header action with a blank routed view", () => {
  assert.match(html, /class="brand-bar"[\s\S]*<h1>[\s\S]*id="principles-tab"[^>]*href="#\/principles"/);
  assert.match(html, /<section id="principles-view" role="tabpanel" aria-labelledby="principles-tab" hidden><\/section>/);
  assert.match(css, /\.brand-bar\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*space-between/s);
});
