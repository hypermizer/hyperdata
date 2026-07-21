import { simulateExposureLadder } from "./lib/exposure-ladder.js?v=20260721-tools";

const form = document.querySelector("#exposure-ladder-form");
const error = document.querySelector("#exposure-ladder-error");
const metrics = document.querySelector("#exposure-ladder-metrics");
const chart = document.querySelector("#exposure-ladder-chart");
const events = document.querySelector("#exposure-ladder-events");

form.addEventListener("input", render);
render();

function readSettings() {
  const values = new FormData(form);
  return {
    direction: values.get("direction"),
    trancheBasis: values.get("trancheBasis"),
    anchorPrice: Number(values.get("anchorPrice")),
    initialUnits: Number(values.get("initialUnits")),
    adverseStepPct: Number(values.get("adverseStepPct")),
    tranchePct: Number(values.get("tranchePct")),
    maxReductionPct: Number(values.get("maxReductionPct")),
    adverseMovePct: Number(values.get("adverseMovePct")),
    recoveryPct: Number(values.get("recoveryPct")),
    reentryStepPct: Number(values.get("reentryStepPct")),
    feeBps: Number(values.get("feeBps")),
  };
}

function render() {
  updateOutputs();
  try {
    const result = simulateExposureLadder(readSettings());
    error.textContent = "";
    renderMetrics(result);
    renderChart(result);
    renderEvents(result);
  } catch (caught) {
    error.textContent = String(caught?.message ?? caught).toUpperCase();
    metrics.innerHTML = "";
    chart.innerHTML = "";
    events.innerHTML = '<p class="hint">ADJUST THE INPUTS TO RUN THE SIMULATION.</p>';
  }
}

function updateOutputs() {
  form.querySelectorAll("input[type=range]").forEach((input) => {
    const output = form.querySelector(`[data-output-for="${input.name}"]`);
    if (!output) return;
    output.value = input.name === "feeBps" ? `${number(input.value, 1)} BPS` : `${number(input.value, 1)}%`;
  });
}

function renderMetrics(result) {
  metrics.innerHTML = [
    ["TURN PRICE", price(result.turnPrice)],
    ["FINAL PRICE", price(result.finalPrice)],
    ["EXPOSURE AT TURN", percent(result.turnExposurePct)],
    ["ENDING EXPOSURE", percent(result.endExposurePct)],
    ["LADDER P/L", money(result.strategyPnl)],
    ["VS. HOLD", signedMoney(result.scalingEffect)],
    ["FEES", money(result.totalFees)],
  ].map(([label, value]) => `<span><small>${label}</small><strong>${value}</strong></span>`).join("");
}

function renderChart(result) {
  const points = result.path;
  const left = 60;
  const right = 835;
  const priceTop = 38;
  const priceBottom = 145;
  const exposureTop = 190;
  const exposureBottom = 295;
  const priceChanges = points.map((point) => (point.price / result.anchorPrice - 1) * 100);
  const priceMin = Math.min(0, ...priceChanges);
  const priceMax = Math.max(0, ...priceChanges);
  const span = Math.max(10, priceMax - priceMin);
  const paddedMin = priceMin - span * 0.08;
  const paddedMax = priceMax + span * 0.08;
  const x = (index) => points.length === 1 ? left : left + (right - left) * index / (points.length - 1);
  const priceY = (value) => priceBottom - (value - paddedMin) / (paddedMax - paddedMin) * (priceBottom - priceTop);
  const exposureY = (value) => exposureBottom - value / 100 * (exposureBottom - exposureTop);
  const priceLine = points.map((point, index) => `${x(index)},${priceY(priceChanges[index])}`).join(" ");
  let exposureLine = `M ${x(0)} ${exposureY(points[0].exposurePct)}`;
  points.slice(1).forEach((point, relativeIndex) => {
    const nextX = x(relativeIndex + 1);
    exposureLine += ` H ${nextX} V ${exposureY(point.exposurePct)}`;
  });
  const turnIndex = Math.max(0, points.findIndex((point) => point.stage === "turn"));
  const priceZeroY = priceY(0);
  const eventDots = points.map((point, index) => `<circle cx="${x(index)}" cy="${priceY(priceChanges[index])}" r="3" class="ladder-price-dot"><title>${point.stage.toUpperCase()} · ${price(point.price)} · ${signedPercent(priceChanges[index])}</title></circle>`).join("");

  chart.innerHTML = `
    <title>Simulated price path and exposure ladder</title>
    <desc>Price moves from the anchor to the adverse turning point and then recovers. Exposure steps down and back up as configured.</desc>
    <g class="ladder-grid">
      <line x1="${left}" y1="${priceZeroY}" x2="${right}" y2="${priceZeroY}" />
      <line x1="${left}" y1="${exposureTop}" x2="${right}" y2="${exposureTop}" />
      <line x1="${left}" y1="${exposureBottom}" x2="${right}" y2="${exposureBottom}" />
      <line x1="${x(turnIndex)}" y1="${priceTop}" x2="${x(turnIndex)}" y2="${exposureBottom}" class="ladder-turn-line" />
    </g>
    <g class="ladder-axis-labels">
      <text x="${left}" y="18">PRICE CHANGE</text>
      <text x="${left - 8}" y="${priceZeroY + 4}" text-anchor="end">0%</text>
      <text x="${left}" y="175">POSITION EXPOSURE</text>
      <text x="${left - 8}" y="${exposureTop + 4}" text-anchor="end">100%</text>
      <text x="${left - 8}" y="${exposureBottom + 4}" text-anchor="end">0%</text>
      <text x="${left}" y="320">START</text>
      <text x="${x(turnIndex)}" y="320" text-anchor="middle">TURN</text>
      <text x="${right}" y="320" text-anchor="end">END</text>
    </g>
    <polyline points="${priceLine}" class="ladder-price-line" />
    ${eventDots}
    <path d="${exposureLine}" class="ladder-exposure-line" />
  `;
}

function renderEvents(result) {
  if (!result.events.length) {
    events.innerHTML = '<p class="hint">NO THRESHOLDS CROSSED.</p>';
    return;
  }
  const rows = result.events.map((event) => {
    const actualMove = (event.price / result.anchorPrice - 1) * 100;
    const timingPnl = event.leg === "recovery"
      ? event.units * (result.direction === "long" ? event.originalScaleOutPrice - event.price : event.price - event.originalScaleOutPrice)
      : null;
    return `<tr><td>${event.leg === "adverse" ? "OUT" : "BACK IN"}</td><td>${signedPercent(actualMove)}</td><td>${event.action}</td><td>${price(event.price)}</td><td>${number(event.units, 6)}</td><td>${percent(event.exposurePct)}</td><td>${timingPnl == null ? "—" : signedMoney(timingPnl)}</td></tr>`;
  }).join("");
  events.innerHTML = `<table class="paper-table"><thead><tr><th>LEG</th><th>PRICE MOVE</th><th>ACTION</th><th>PRICE</th><th>UNITS</th><th>EXPOSURE</th><th>TRANCHE TIMING P/L</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function number(value, maximumFractionDigits = 2) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits });
}

function price(value) {
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function money(value) {
  return `${Number(value) < 0 ? "−" : ""}$${Math.abs(Number(value)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(value) {
  return `${Number(value) > 0 ? "+" : Number(value) < 0 ? "−" : ""}$${Math.abs(Number(value)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(value) {
  return `${number(value, 2)}%`;
}

function signedPercent(value) {
  return `${Number(value) > 0 ? "+" : ""}${number(value, 2)}%`;
}
