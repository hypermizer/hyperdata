export const STREAM_CONNECT_TIMEOUT_MS = 15_000;
export const STREAM_SILENT_MS = 45_000;
export const STREAM_RECONNECT_MS = 65_000;

export function deriveStreamHealth({ phase, startedAt = 0, openedAt = 0, lastMessageAt = 0, now = Date.now(), detail = "" }) {
  if (phase === "error") {
    return {
      label: `HYPERLIQUID DISCONNECTED${detail ? ` · ${detail}` : ""}`,
      tone: "negative",
      shouldReconnect: false,
    };
  }
  if (phase === "loading") {
    return { label: "LOADING MARKET DATA", tone: "", shouldReconnect: false };
  }
  if (phase === "connecting") {
    if (startedAt && now - startedAt > STREAM_CONNECT_TIMEOUT_MS) {
      return { label: "HYPERLIQUID RECONNECTING", tone: "warning", shouldReconnect: true };
    }
    return { label: "HYPERLIQUID CONNECTING", tone: "warning", shouldReconnect: false };
  }
  if (phase !== "open") {
    return { label: "HYPERLIQUID RECONNECTING", tone: "warning", shouldReconnect: false };
  }

  const lastActivityAt = Math.max(openedAt, lastMessageAt);
  const silentFor = Math.max(0, now - lastActivityAt);
  if (silentFor > STREAM_RECONNECT_MS) {
    return { label: "HYPERLIQUID RECONNECTING", tone: "warning", shouldReconnect: true };
  }
  if (silentFor > STREAM_SILENT_MS) {
    return {
      label: "HYPERLIQUID DEGRADED · STREAM SILENT",
      tone: "warning",
      shouldReconnect: false,
    };
  }
  return { label: "HYPERLIQUID CONNECTED", tone: "positive", shouldReconnect: false };
}
