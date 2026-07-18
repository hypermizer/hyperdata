export function normalizeAlertRuleInput(input) {
  const asset = String(input.asset ?? "").trim();
  const delivery = String(input.delivery ?? "email");
  const detector = String(input.detector ?? "fixed_price");
  if (!asset) throw new Error("Choose an asset.");
  if (!["email", "sms"].includes(delivery)) throw new Error("Invalid delivery channel.");
  if (detector === "fixed_price") {
    const direction = String(input.direction);
    const target = Number(input.target);
    if (!["above", "below"].includes(direction) || !Number.isFinite(target) || target <= 0) throw new Error("Enter a valid fixed-price rule.");
    return { detector, asset, delivery, configuration: { direction, target } };
  }
  if (detector === "large_move") {
    const direction = String(input.direction); const horizon = Number(input.horizonMinutes);
    const tailPercentile = Number(input.tailPercentile); const minimumMovePercent = Number(input.minimumMovePercent ?? 0);
    if (!["up", "down", "either"].includes(direction) || !Number.isInteger(horizon) || horizon < 1 || horizon > 10080) throw new Error("Enter a valid move horizon.");
    if (!Number.isFinite(tailPercentile) || tailPercentile < 0.9 || tailPercentile > 0.9999) throw new Error("Enter a valid empirical percentile.");
    if (!Number.isFinite(minimumMovePercent) || minimumMovePercent < 0) throw new Error("Enter a valid minimum move.");
    return { detector, asset, delivery, configuration: { direction, horizon_minutes: horizon, tail_percentile: tailPercentile, minimum_move_percent: minimumMovePercent } };
  }
  throw new Error("Unsupported rule type.");
}

export function displayRule(rule) {
  const asset = rule.asset.startsWith("xyz:") ? rule.asset.slice(4) : rule.asset;
  if (rule.detector === "fixed_price") return `${asset} ${rule.configuration.direction} ${formatPrice(rule.configuration.target)}`;
  const direction = rule.configuration.direction === "either" ? "either way" : rule.configuration.direction;
  return `${asset} ${direction} · ${rule.configuration.horizon_minutes}m · ${(rule.configuration.tail_percentile * 100).toFixed(1)}% tail`;
}

export function listenerHealth(run, now = Date.now()) {
  if (!run) return "NO MONITOR RUNS";
  if (run.state === "claimed") return "MONITOR RUNNING";
  const timestamp = Date.parse(run.finished_at ?? run.started_at);
  const ageMinutes = (now - timestamp) / 60_000;
  if (!Number.isFinite(timestamp) || ageMinutes > 3) return "MONITOR STALE";
  return run.state === "succeeded" ? "MONITOR HEALTHY" : run.state === "partial" ? "MONITOR PARTIAL" : "MONITOR FAILED";
}

function formatPrice(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Number(value) >= 1 ? 2 : 6 }).format(value);
}
