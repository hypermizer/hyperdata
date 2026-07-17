import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewIssueUrl,
  createAlertIssue,
  isAlertTriggered,
  normalizeAlert,
  parseAlertIssue,
} from "../public/lib/alerts.js";

test("normalizes a HIP-3 alert and infers its dex", () => {
  assert.deepEqual(
    normalizeAlert({ asset: "xyz:ORCL", direction: "ABOVE", target: "175.25" }),
    { asset: "xyz:ORCL", dex: "xyz", direction: "above", target: 175.25 },
  );
});

test("rejects unsafe or invalid alerts", () => {
  assert.throws(
    () => normalizeAlert({ asset: "ORCL<script>", direction: "above", target: 10 }),
    /valid Hyperliquid asset/,
  );
  assert.throws(
    () => normalizeAlert({ asset: "xyz:ORCL", direction: "sideways", target: 10 }),
    /Direction/,
  );
  assert.throws(
    () => normalizeAlert({ asset: "xyz:ORCL", direction: "above", target: 0 }),
    /greater than zero/,
  );
});

test("issue payload round-trips through its machine-readable marker", () => {
  const source = { asset: "xyz:XYZ100", dex: "xyz", direction: "below", target: 22100 };
  const issue = createAlertIssue(source);
  assert.match(issue.title, /XYZ100 below/);
  assert.deepEqual(parseAlertIssue(issue.body), source);
});

test("malformed issue bodies are ignored", () => {
  assert.equal(parseAlertIssue("No alert here"), null);
  assert.equal(parseAlertIssue("<!-- hyperdata-alert {nope} -->"), null);
});

test("threshold comparisons include the exact target", () => {
  const above = { asset: "xyz:ORCL", direction: "above", target: 100 };
  const below = { asset: "xyz:ORCL", direction: "below", target: 100 };
  assert.equal(isAlertTriggered(above, 100), true);
  assert.equal(isAlertTriggered(above, 99.99), false);
  assert.equal(isAlertTriggered(below, 100), true);
  assert.equal(isAlertTriggered(below, 100.01), false);
  assert.equal(isAlertTriggered(above, "not-a-price"), false);
});

test("new issue URL carries the alert body and label", () => {
  const url = new URL(
    buildNewIssueUrl("owner/repo", {
      asset: "xyz:ORCL",
      direction: "above",
      target: 200,
    }),
  );
  assert.equal(url.pathname, "/owner/repo/issues/new");
  assert.equal(url.searchParams.get("labels"), "price-alert");
  assert.match(url.searchParams.get("body"), /hyperdata-alert/);
});
