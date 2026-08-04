export const MAX_TRADE_CSV_BYTES = 10 * 1024 * 1024;

export async function prepareTradeCsv(file) {
  const fileName = String(file?.name ?? "").trim();
  if (!fileName || !/\.csv$/i.test(fileName)) throw new Error("SELECT A CSV FILE");
  if (fileName.length > 255) throw new Error("CSV FILE NAME IS TOO LONG");

  const declaredSize = Number(file?.size);
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) throw new Error("CSV FILE IS EMPTY");
  if (declaredSize > MAX_TRADE_CSV_BYTES) throw new Error("CSV FILE MUST BE 10 MB OR SMALLER");
  if (typeof file?.arrayBuffer !== "function") throw new Error("CSV FILE COULD NOT BE READ");

  const bytes = await file.arrayBuffer();
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== declaredSize) {
    throw new Error("CSV FILE COULD NOT BE READ");
  }

  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("CSV FILE MUST USE UTF-8 TEXT");
  }
  if (!content.trim()) throw new Error("CSV FILE IS EMPTY");
  if (content.includes("\0")) throw new Error("CSV FILE MUST USE UTF-8 TEXT");

  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const contentSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return { fileName, fileSize: bytes.byteLength, contentSha256, content };
}
