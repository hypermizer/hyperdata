export function validateRule(input: Record<string, unknown>) {
  const asset = String(input.asset ?? "").trim(),
    dex = asset.includes(":") ? asset.split(":")[0] : "",
    detector = String(input.detector ?? "fixed_price");
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(asset)) {
    throw new Error("Choose a valid asset.");
  }
  const c = input.configuration as Record<string, unknown>;
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    throw new Error("Invalid alert configuration.");
  }
  if (detector === "fixed_price") {
    const direction = String(c.direction), target = Number(c.target);
    if (
      !["above", "below"].includes(direction) || typeof c.target !== "number" ||
      !Number.isFinite(target) || target <= 0
    ) throw new Error("Enter a positive, finite target price.");
    return { asset, dex, detector, configuration: { direction, target } };
  }
  if (detector === "large_move") {
    const direction = String(c.direction),
      h = Number(c.horizon_minutes),
      p = Number(c.tail_percentile),
      floor = Number(c.minimum_move_percent);
    if (
      !["up", "down", "either"].includes(direction) || !Number.isInteger(h) ||
      h < 1 || h > 10080 || !Number.isFinite(p) || p < 0.9 || p > 0.9999 ||
      !Number.isFinite(floor) || floor < 0
    ) throw new Error("Invalid move-alert parameters.");
    return {
      asset,
      dex,
      detector,
      configuration: {
        direction,
        horizon_minutes: h,
        tail_percentile: p,
        minimum_move_percent: floor,
      },
    };
  }
  throw new Error("Unsupported detector.");
}
