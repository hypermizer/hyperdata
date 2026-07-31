import assert from "node:assert/strict";
import test from "node:test";
import { createTransientMessageScheduler } from "../public/lib/transient-message.js";

test("transient messages clear their text and tone after five seconds", () => {
  let callback;
  let delay;
  const element = { textContent: "SAVED", dataset: { tone: "success" } };
  const schedule = createTransientMessageScheduler({
    setTimer: (nextCallback, milliseconds) => { callback = nextCallback; delay = milliseconds; return 1; },
    clearTimer: () => {},
  });

  schedule(element);
  assert.equal(delay, 5_000);
  callback();
  assert.equal(element.textContent, "");
  assert.equal("tone" in element.dataset, false);
});
