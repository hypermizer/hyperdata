import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TRADE_CSV_BYTES, prepareTradeCsv } from "../public/lib/trade-csv.js";

function csvFile(name, content, size = new TextEncoder().encode(content).byteLength) {
  return {
    name,
    size,
    async arrayBuffer() {
      return new TextEncoder().encode(content).buffer;
    },
  };
}

test("prepares an opaque Hyperliquid CSV without assuming its columns", async () => {
  const content = "time,coin,side\n2026-08-04T12:00:00Z,DRAM,Buy\n";
  const prepared = await prepareTradeCsv(csvFile("hyperliquid.csv", content));

  assert.equal(prepared.fileName, "hyperliquid.csv");
  assert.equal(prepared.fileSize, new TextEncoder().encode(content).byteLength);
  assert.equal(prepared.content, content);
  assert.match(prepared.contentSha256, /^[a-f0-9]{64}$/);
});

test("accepts an uppercase CSV extension", async () => {
  const prepared = await prepareTradeCsv(csvFile("fills.CSV", "a,b\n1,2\n"));
  assert.equal(prepared.fileName, "fills.CSV");
});

test("preserves a UTF-8 byte-order mark so stored size matches the uploaded file", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a,b\n1,2\n")]);
  const prepared = await prepareTradeCsv({
    name: "fills.csv",
    size: bytes.byteLength,
    async arrayBuffer() { return bytes.buffer; },
  });

  assert.equal(new TextEncoder().encode(prepared.content).byteLength, bytes.byteLength);
  assert.equal(prepared.content.charCodeAt(0), 0xfeff);
});

test("rejects non-CSV, empty, oversized, and invalid UTF-8 files", async () => {
  await assert.rejects(() => prepareTradeCsv(csvFile("fills.txt", "a,b\n")), /CSV FILE/);
  await assert.rejects(() => prepareTradeCsv(csvFile("fills.csv", "")), /EMPTY/);
  await assert.rejects(() => prepareTradeCsv(csvFile("fills.csv", "x", MAX_TRADE_CSV_BYTES + 1)), /10 MB/);
  await assert.rejects(() => prepareTradeCsv({
    name: "fills.csv",
    size: 2,
    async arrayBuffer() { return new Uint8Array([0xc3, 0x28]).buffer; },
  }), /UTF-8/);
});

test("rejects mismatched byte counts and overlong names", async () => {
  await assert.rejects(() => prepareTradeCsv(csvFile("fills.csv", "a,b\n", 99)), /COULD NOT BE READ/);
  await assert.rejects(() => prepareTradeCsv(csvFile(`${"a".repeat(252)}.csv`, "a,b\n")), /FILE NAME/);
});
