export function displayStrategyAsset(value) {
  return String(value ?? "—").replace(/^xyz:/, "");
}

export function strategyRuleSummary(parameters = {}) {
  const period = Number(parameters.rsiPeriod ?? 14);
  const baseline = Number(parameters.baselineLength ?? 100);
  const short = Number(parameters.shortRatio ?? 1.9).toFixed(2);
  const long = Number(parameters.longRatio ?? .1).toFixed(2);
  const stop = Math.abs(Number(parameters.stopReturn ?? -.1) * 100);
  const take = Number(parameters.takeReturn ?? .2) * 100;
  return `WILDER RSI(${period}) · 5M + 1H · RATIO = CURRENT ÷ PRIOR-${baseline} AVERAGE · SHORT ≥ ${short} · LONG ≤ ${long} · EXIT AT ${stop}% LOSS / ${take}% GAIN IN NET RETURN ON INITIAL MARGIN`;
}

export function strategyStateLabel(assignment) {
  const state = String(assignment?.state ?? "unknown").replaceAll("_", " ").toUpperCase();
  const reason = assignment?.degraded_reason ? ` · ${String(assignment.degraded_reason).replaceAll("_", " ").toUpperCase()}` : "";
  return `${state}${reason}`;
}

export function summarizeBacktest(run) {
  const state = String(run?.status ?? "unknown").toUpperCase();
  if (!["completed", "degraded"].includes(String(run?.status))) return `${state} · ${Number(run?.progress ?? 0)}%`;
  const metrics = run?.metrics?.portfolio ?? {};
  return `${state} · ${Number(metrics.tradeCount ?? 0)} TRADES · ${money(metrics.netPnl ?? 0)}`;
}

export function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number < 0 ? "-" : ""}$${Math.abs(number).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
}

export function escapeStrategyHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
