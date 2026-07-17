export const ALERT_MARKER = "hyperdata-alert";
export const ALERT_LABEL = "price-alert";
export const TRIGGERED_LABEL = "alert-triggered";

export function normalizeAlert(input) {
  const asset = String(input.asset ?? "").trim();
  const direction = String(input.direction ?? "").trim().toLowerCase();
  const delivery = String(input.delivery ?? "email").trim().toLowerCase();
  const target = Number(input.target);
  const dex = String(
    input.dex ?? (asset.includes(":") ? asset.split(":")[0] : ""),
  ).trim();

  if (!asset || !/^[a-zA-Z0-9_.:-]+$/.test(asset)) {
    throw new Error("Choose a valid Hyperliquid asset");
  }
  if (!["above", "below"].includes(direction)) {
    throw new Error("Direction must be above or below");
  }
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error("Target price must be greater than zero");
  }
  if (!["email", "sms"].includes(delivery)) {
    throw new Error("Delivery must be email or text");
  }

  return { asset, dex, direction, target, delivery };
}

export function createAlertIssue(alertInput) {
  const alert = normalizeAlert(alertInput);
  const target = formatTarget(alert.target);
  const symbol = alert.asset.split(":").at(-1);
  const title = `[Price alert] ${symbol} ${alert.direction} $${target}`;
  const body = [
    `Notify me by **${alert.delivery === "sms" ? "text" : "email"}** when **${alert.asset}** trades ${alert.direction} **$${target}**.`,
    "",
    "This issue is monitored automatically by Hyperdata. Closing it cancels the alert.",
    "",
    `<!-- ${ALERT_MARKER}`,
    JSON.stringify(alert),
    "-->",
  ].join("\n");

  return { alert, title, body };
}

export function buildNewIssueUrl(repository, alertInput) {
  const { title, body } = createAlertIssue(alertInput);
  const params = new URLSearchParams({
    title,
    body,
    labels: ALERT_LABEL,
  });
  return `https://github.com/${repository}/issues/new?${params}`;
}

export function parseAlertIssue(body) {
  if (typeof body !== "string") return null;
  const pattern = new RegExp(
    `<!--\\s*${ALERT_MARKER}\\s*([\\s\\S]*?)\\s*-->`,
  );
  const match = body.match(pattern);
  if (!match) return null;

  try {
    return normalizeAlert(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

export function isAlertTriggered(alertInput, markPriceInput) {
  const alert = normalizeAlert(alertInput);
  const markPrice = Number(markPriceInput);
  if (!Number.isFinite(markPrice) || markPrice <= 0) return false;
  return alert.direction === "above"
    ? markPrice >= alert.target
    : markPrice <= alert.target;
}

function formatTarget(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 8,
    useGrouping: false,
  }).format(value);
}
