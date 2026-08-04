function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`INVALID ${field.toUpperCase()}`);
  return number;
}

export function normalizeAccountFill(row) {
  const size = finite(row.size, "fill size");
  const price = finite(row.price, "fill price");
  return {
    tradeId: String(row.trade_id), asset: String(row.asset), side: String(row.side), direction: String(row.direction),
    size, price, value: size * price,
    closedPnl: finite(row.closed_pnl ?? 0, "closed pnl"), fee: finite(row.fee ?? 0, "fee"),
    feeToken: row.fee_token ? String(row.fee_token) : "", occurredAt: String(row.occurred_at),
    orderId: String(row.order_id), transactionHash: row.transaction_hash ? String(row.transaction_hash) : "",
  };
}

function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}S AGO`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}M AGO`;
  return `${Math.floor(minutes / 60)}H AGO`;
}

export function accountSyncHealth(source, now = Date.now()) {
  if (source?.last_error) return { label: `SYNC ERROR · ${String(source.last_error).toUpperCase()}`, tone: "error" };
  if (!source?.last_success_at) return { label: "AWAITING FIRST SYNC", tone: "warning" };
  const age = now - Date.parse(source.last_success_at);
  if (!Number.isFinite(age)) return { label: "SYNC TIME INVALID", tone: "error" };
  return { label: `${age <= 150_000 ? "LIVE" : "STALE"} · ${elapsedLabel(age)}`, tone: age <= 150_000 ? "live" : "warning" };
}
