import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAM_CONNECT_TIMEOUT_MS,
  STREAM_RECONNECT_MS,
  STREAM_SILENT_MS,
  deriveStreamHealth,
} from "../public/lib/stream-health.js";

test("a stream that never opens times out and reconnects", () => {
  const now = 100_000;
  assert.equal(deriveStreamHealth({
    phase: "connecting",
    startedAt: now - STREAM_CONNECT_TIMEOUT_MS - 1,
    now,
  }).shouldReconnect, true);
});

test("an open stream stays connected when server messages continue", () => {
  const now = 100_000;
  assert.deepEqual(deriveStreamHealth({
    phase: "open",
    openedAt: now - STREAM_RECONNECT_MS,
    lastMessageAt: now - 1_000,
    now,
  }), {
    label: "HYPERLIQUID CONNECTED",
    tone: "positive",
    shouldReconnect: false,
  });
});

test("an open stream degrades only after all server traffic is silent", () => {
  const now = 100_000;
  assert.deepEqual(deriveStreamHealth({
    phase: "open",
    openedAt: now - STREAM_SILENT_MS - 1,
    lastMessageAt: 0,
    now,
  }), {
    label: "HYPERLIQUID DEGRADED · STREAM SILENT",
    tone: "warning",
    shouldReconnect: false,
  });
});

test("a persistently silent or closed stream reports reconnecting", () => {
  const now = 100_000;
  assert.equal(deriveStreamHealth({
    phase: "open",
    openedAt: now - STREAM_RECONNECT_MS - 1,
    lastMessageAt: 0,
    now,
  }).shouldReconnect, true);
  assert.deepEqual(deriveStreamHealth({ phase: "closed", now }), {
    label: "HYPERLIQUID RECONNECTING",
    tone: "warning",
    shouldReconnect: false,
  });
});
