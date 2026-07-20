import assert from "node:assert/strict";
import test from "node:test";
import { audioStreamUrl, listenerAssetCatalog } from "../public/lib/audio.js";

const catalog = [
  { id: "BTC", symbol: "BTC" },
  { id: "xyz:ORCL", symbol: "ORCL" },
  { id: "xyz:DRAM", symbol: "DRAM" },
];

test("listener asset catalog keeps watchlist assets first and remembered assets once", () => {
  assert.deepEqual(
    listenerAssetCatalog(["xyz:ORCL", "BTC"], ["xyz:DRAM", "xyz:ORCL", "missing"], catalog).map(({ id }) => id),
    ["xyz:ORCL", "BTC", "xyz:DRAM"],
  );
});

test("audio stream URL carries the full Hyperliquid asset id", () => {
  assert.equal(
    audioStreamUrl("https://audio.example/live.mp3", "xyz:ORCL", 123),
    "https://audio.example/live.mp3?asset=xyz%3AORCL&session=123",
  );
});
