import { paperInitialMargin, paperMaintenanceMargin } from "./paper.js";

export const PAPER_QUOTE_STALE_MS = 5_000;
export const PAPER_STREAM_RECONNECT_MS = 15_000;
export const PAPER_ENGINE_STALE_MS = 75_000;

export function paperQuoteAssets(positions = [], activeAsset = "") {
  return [...new Set([
    ...positions.map(({ asset }) => String(asset ?? "").trim()),
    String(activeAsset ?? "").trim(),
  ].filter(Boolean))].sort();
}

export function quoteIsFresh(quote, now = Date.now()) {
  const price = Number(quote?.markPrice);
  const updatedAt = Number(quote?.updatedAt);
  const age = now - updatedAt;
  return price > 0 && Number.isFinite(updatedAt) && age >= 0 && age <= PAPER_QUOTE_STALE_MS;
}

export function projectLivePaperAccount({
  summary = {}, positions = [], leverageSettings = [], markets = new Map(), quotes = new Map(), now = Date.now(),
}) {
  const leverageByAsset = new Map(leverageSettings.map(({ asset, leverage }) => [asset, Number(leverage)]));
  const staleAssets = [];
  const livePositions = positions.map((position) => {
    const quote = quotes.get(position.asset);
    const live = quoteIsFresh(quote, now);
    if (!live) staleAssets.push(position.asset);
    return {
      ...position,
      mark_price: live ? Number(quote.markPrice) : Number(position.mark_price),
    };
  });

  const totals = livePositions.reduce((result, position) => {
    const size = Number(position.signed_size);
    const mark = Number(position.mark_price);
    const entry = Number(position.entry_price);
    if (!Number.isFinite(size) || !Number.isFinite(mark) || !Number.isFinite(entry)) return result;
    const notional = Math.abs(size) * mark;
    const market = markets.get(position.asset);
    result.unrealized += size * (mark - entry);
    result.notional += notional;
    result.maintenance += paperMaintenanceMargin(notional, market?.marginTiers);
    result.margin += position.margin_mode === "isolated"
      ? Math.max(0, Number(position.isolated_margin) || 0)
      : paperInitialMargin(notional, leverageByAsset.get(position.asset) ?? 1, market?.marginTiers);
    return result;
  }, { unrealized: 0, notional: 0, margin: 0, maintenance: 0 });
  const cash = Number(summary.cash_balance) || 0;

  return {
    positions: livePositions,
    staleAssets,
    summary: {
      ...summary,
      unrealized_pnl: totals.unrealized,
      equity: cash + totals.unrealized,
      total_notional: totals.notional,
      margin_used: totals.margin,
      maintenance_margin: totals.maintenance,
    },
  };
}

export function paperEngineHealth(health, now = Date.now()) {
  if (!health?.latest_finished_at) {
    return { state: "unavailable", label: "PAPER ENGINE UNAVAILABLE", tone: "negative" };
  }
  const age = now - Date.parse(health.latest_finished_at);
  if (!Number.isFinite(age) || age < 0 || age > PAPER_ENGINE_STALE_MS) {
    return { state: "stale", label: "PAPER ENGINE STALE", tone: "negative" };
  }
  if (health.latest_state !== "succeeded") {
    return { state: "degraded", label: `PAPER ENGINE ${String(health.latest_state ?? "DEGRADED").toUpperCase()}`, tone: "warning" };
  }
  return { state: "live", label: "LIVE PAPER ENGINE", tone: "positive" };
}
