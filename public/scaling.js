import { AssetPicker } from "./asset-picker.js?v=20260720-picker";
import { APP_CONFIG } from "./config.js?v=20260801-scaling";
import { applyLiveMarketContext } from "./lib/hyperliquid.js?v=20260722-position-controls";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260720-assets";
import {
  generationSettingsKey,
  lotUnitsFromDrag,
  priceFromDrag,
  rebasePathPoints,
  scalingSettingsAtAnchor,
} from "./lib/scaling-interactions.js?v=20260803-scaling-reliability-3";
import {
  evenlySpaceScalingLevels,
  generateScalingLevels,
  scalingPlanSummary,
  simulateScalingPath,
} from "./lib/scaling-simulator.js?v=20260801-scaling";

function number(value, maximumFractionDigits = 2) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits });
}

function price(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function money(value) {
  return `${Number(value) < 0 ? "−" : ""}$${Math.abs(Number(value)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(value) {
  return `${Number(value) > 0 ? "+" : Number(value) < 0 ? "−" : ""}$${Math.abs(Number(value)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const scaling = {
  form: document.querySelector("#scaling-form"),
  pickerRoot: document.querySelector("#scaling-asset-picker"),
  liveMark: document.querySelector("#scaling-live-mark"),
  liveStatus: document.querySelector("#scaling-live-status"),
  maxLossConversion: document.querySelector("#scaling-max-loss-conversion"),
  lotConversion: document.querySelector("#scaling-lot-conversion"),
  rangeOutput: document.querySelector("#scaling-range-output"),
  generationStatus: document.querySelector("#scaling-generation-status"),
  error: document.querySelector("#scaling-error"),
  planMetrics: document.querySelector("#scaling-plan-metrics"),
  resultMetrics: document.querySelector("#scaling-result-metrics"),
  ladder: document.querySelector("#scaling-ladder-chart"),
  levelList: document.querySelector("#scaling-level-list"),
  path: document.querySelector("#scaling-path-chart"),
  events: document.querySelector("#scaling-events"),
  generate: document.querySelector("#scaling-generate"),
  rebase: document.querySelector("#scaling-rebase"),
  addLevel: document.querySelector("#scaling-add-level"),
};

const scalingPicker = new AssetPicker(scaling.pickerRoot, { details: "none" });
const scalingState = {
  catalog: [],
  market: null,
  anchorPrice: 100,
  appliedSettings: null,
  generationDirty: false,
  levels: [],
  pathPoints: [],
  selectedLevelId: "",
  drag: null,
  pathDrag: null,
  pathMode: "draw",
  scrubIndex: null,
  stream: null,
  streamAsset: "",
  streamUpdatedAt: 0,
  reconnectTimer: 0,
  renderFrame: 0,
};

const GENERATION_FIELDS = new Set(["direction", "maxRisk", "maxLoss", "maxLossMode", "startingLot", "startingLotMode", "levelCount", "feeBps"]);

initializeScaling();

async function initializeScaling() {
  bindScalingEvents();
  try {
    scalingState.catalog = await getMarketCatalog();
    scalingPicker.setCatalog(scalingState.catalog);
    const initial = scalingState.catalog.find(({ id }) => id === "xyz:DRAM") ?? scalingState.catalog[0];
    if (initial) scalingPicker.select(initial.id);
  } catch (caught) {
    scaling.error.textContent = `ASSET CATALOG FAILED — ${String(caught?.message ?? caught).toUpperCase()}`;
  }
}

function bindScalingEvents() {
  scaling.pickerRoot.addEventListener("assetchange", () => selectScalingAsset(scalingPicker.value));
  scaling.generate.addEventListener("click", () => regenerateScalingPlan());
  scaling.rebase.addEventListener("click", rebaseScalingPlan);
  scaling.addLevel.addEventListener("click", addScalingLevel);
  scaling.form.addEventListener("input", ({ target }) => {
    if (target.name === "rangePct") scaling.rangeOutput.value = `±${number(target.value, 0)}%`;
    if (GENERATION_FIELDS.has(target.name)) refreshScalingSettingsDirty();
    updateScalingConversions();
    if (target.name === "rangePct") scheduleScalingRender();
  });
  scaling.form.addEventListener("change", ({ target }) => {
    if (target.name === "startingLotMode" || target.name === "maxLossMode") updateScalingConversions();
  });
  scaling.levelList.addEventListener("change", editScalingLevel);
  scaling.levelList.addEventListener("click", ({ target }) => {
    const remove = target.closest("[data-remove-level]");
    if (remove) removeScalingLevel(remove.dataset.removeLevel);
  });
  document.querySelectorAll("[data-scaling-batch]").forEach((button) => button.addEventListener("click", () => applyScalingBatch(button.dataset.scalingBatch)));
  document.querySelectorAll("[data-path-preset]").forEach((button) => button.addEventListener("click", () => setPathPreset(button.dataset.pathPreset)));
  document.querySelectorAll("[data-path-mode]").forEach((button) => button.addEventListener("click", () => setPathMode(button.dataset.pathMode)));
  scaling.ladder.addEventListener("pointerdown", startLadderDrag);
  scaling.ladder.addEventListener("pointermove", moveLadderDrag);
  scaling.ladder.addEventListener("pointerup", endLadderDrag);
  scaling.ladder.addEventListener("pointercancel", endLadderDrag);
  scaling.path.addEventListener("pointerdown", startPathInteraction);
  scaling.path.addEventListener("pointermove", movePathInteraction);
  scaling.path.addEventListener("pointerup", endPathInteraction);
  scaling.path.addEventListener("pointercancel", endPathInteraction);
  window.setInterval(renderScalingQuoteStatus, 1_000);
  window.setInterval(() => {
    if (scalingState.stream?.readyState === WebSocket.OPEN) scalingState.stream.send(JSON.stringify({ method: "ping" }));
  }, 30_000);
  window.addEventListener("hashchange", syncScalingStream);
}

function selectScalingAsset(assetId) {
  const market = scalingState.catalog.find(({ id }) => id === assetId);
  if (!market) return;
  scalingState.market = market;
  scalingState.anchorPrice = Number(market.markPrice) || 100;
  scalingState.streamUpdatedAt = 0;
  scalingState.streamAsset = assetId;
  if (scalingRouteIsActive()) connectScalingStream(assetId);
  scalingState.pathPoints = [];
  regenerateScalingPlan();
}

function scalingRouteIsActive() {
  return window.location.hash === "#/tools/scaling";
}

function syncScalingStream() {
  if (scalingRouteIsActive() && scalingState.streamAsset) {
    if (!scalingState.stream || scalingState.stream.readyState >= WebSocket.CLOSING) connectScalingStream(scalingState.streamAsset);
    return;
  }
  window.clearTimeout(scalingState.reconnectTimer);
  const stream = scalingState.stream;
  scalingState.stream = null;
  stream?.close();
  renderScalingQuoteStatus();
}

function connectScalingStream(assetId) {
  window.clearTimeout(scalingState.reconnectTimer);
  scalingState.stream?.close();
  scalingState.streamAsset = assetId;
  const stream = new WebSocket(APP_CONFIG.websocketUrl);
  scalingState.stream = stream;
  stream.addEventListener("open", () => {
    if (scalingState.stream !== stream) return;
    stream.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: assetId } }));
    renderScalingQuoteStatus();
  });
  stream.addEventListener("message", ({ data }) => {
    if (scalingState.stream !== stream) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.channel !== "activeAssetCtx" || message.data?.coin !== assetId) return;
    scalingState.market = applyLiveMarketContext(scalingState.market, message.data.ctx);
    scalingState.streamUpdatedAt = Date.now();
    scaling.liveMark.textContent = price(scalingState.market.markPrice);
    renderScalingQuoteStatus();
  });
  stream.addEventListener("close", () => {
    if (scalingState.stream !== stream) return;
    renderScalingQuoteStatus();
    scalingState.reconnectTimer = window.setTimeout(() => connectScalingStream(scalingState.streamAsset), 3_000);
  });
  stream.addEventListener("error", () => stream.close());
}

function renderScalingQuoteStatus() {
  const age = scalingState.streamUpdatedAt ? Date.now() - scalingState.streamUpdatedAt : Infinity;
  const open = scalingState.stream?.readyState === WebSocket.OPEN;
  scaling.liveMark.textContent = price(scalingState.market?.markPrice);
  scaling.liveStatus.textContent = open && age <= 5_000 ? "LIVE" : open ? "WAITING" : "RECONNECTING";
  scaling.liveStatus.classList.toggle("is-live", open && age <= 5_000);
}

function readScalingSettings() {
  const values = new FormData(scaling.form);
  return scalingSettingsAtAnchor({
    direction: values.get("direction"),
    maxRisk: values.get("maxRisk"),
    maxLossInput: values.get("maxLoss"),
    maxLossMode: values.get("maxLossMode"),
    startingLotInput: values.get("startingLot"),
    startingLotMode: values.get("startingLotMode"),
    levelCount: values.get("levelCount"),
    feeBps: values.get("feeBps"),
    rangePct: values.get("rangePct"),
  }, scalingState.anchorPrice);
}

function activeScalingSettings() {
  return {
    ...scalingState.appliedSettings,
    rangePct: Number(new FormData(scaling.form).get("rangePct")),
  };
}

function regenerateScalingPlan(settings = readScalingSettings()) {
  try {
    const generated = generateScalingLevels(settings);
    scalingState.anchorPrice = settings.anchorPrice;
    scalingState.levels = generated.levels;
    scalingState.appliedSettings = { ...settings };
    scalingState.selectedLevelId = generated.levels[0]?.id ?? "";
    if (!scalingState.pathPoints.length) setPathPreset("chop", false);
    scaling.error.textContent = "";
    refreshScalingSettingsDirty();
    renderScalingGenerationStatus();
    renderScaling();
    return true;
  } catch (caught) {
    scaling.error.textContent = String(caught?.message ?? caught).toUpperCase();
    return false;
  }
}

function rebaseScalingPlan() {
  const livePrice = Number(scalingState.market?.markPrice);
  if (!Number.isFinite(livePrice) || livePrice <= 0) {
    scaling.error.textContent = "A LIVE MARK IS REQUIRED TO REBASE";
    return;
  }
  const previousAnchor = scalingState.anchorPrice;
  const previousPath = scalingState.pathPoints.map((point) => ({ ...point }));
  const rebasedSettings = scalingSettingsAtAnchor(scalingState.appliedSettings, livePrice);
  scalingState.pathPoints = rebasePathPoints(scalingState.pathPoints, previousAnchor, livePrice);
  if (!regenerateScalingPlan(rebasedSettings)) {
    const error = scaling.error.textContent;
    scalingState.anchorPrice = previousAnchor;
    scalingState.pathPoints = previousPath;
    renderScaling();
    scaling.error.textContent = error;
  }
}

function refreshScalingSettingsDirty() {
  if (!scalingState.appliedSettings) return;
  scalingState.generationDirty = generationSettingsKey(readScalingSettings()) !== generationSettingsKey(scalingState.appliedSettings);
  renderScalingGenerationStatus();
}

function renderScalingGenerationStatus() {
  if (scalingState.generationDirty) {
    scaling.generationStatus.textContent = "CHANGES NOT APPLIED · CURRENT RESULTS STILL USE THE LAST APPLIED SETTINGS";
    scaling.generationStatus.classList.add("is-dirty");
    return;
  }
  scaling.generationStatus.textContent = `SCENARIO SETTINGS APPLIED · ANCHOR LOCKED AT ${price(scalingState.anchorPrice)}`;
  scaling.generationStatus.classList.remove("is-dirty");
}

function updateScalingConversions() {
  try {
    const settings = readScalingSettings();
    const lossPercent = settings.maxRisk > 0 ? settings.maxLoss / settings.maxRisk * 100 : 0;
    scaling.maxLossConversion.textContent = settings.maxLossMode === "percent"
      ? money(settings.maxLoss)
      : `${number(lossPercent, 2)}% OF MAX ALLOCATION`;
    scaling.lotConversion.textContent = settings.startingLotMode === "shares"
      ? money(settings.startingLotUnits * scalingState.anchorPrice)
      : `${number(settings.startingLotUnits, 6)} SHARES`;
  } catch {
    scaling.maxLossConversion.textContent = "—";
    scaling.lotConversion.textContent = "—";
  }
}

function scheduleScalingRender() {
  if (scalingState.renderFrame) return;
  scalingState.renderFrame = window.requestAnimationFrame(() => {
    scalingState.renderFrame = 0;
    renderScaling();
  });
}

function renderScaling() {
  updateScalingConversions();
  if (!scalingState.appliedSettings || !scalingState.levels.length) return;
  try {
    const settings = activeScalingSettings();
    const summary = scalingPlanSummary({ ...settings, levels: scalingState.levels });
    const bounds = scalingBounds(summary, settings.rangePct);
    renderScalingPlanMetrics(summary);
    renderScalingLadder(summary, bounds);
    renderScalingLevelList(summary);
    if (summary.remainingRisk < -1e-6) {
      scaling.error.textContent = `PLANNED ENTRIES EXCEED MAX RISK BY ${money(-summary.remainingRisk)}`;
      renderScalingPath(null, bounds);
      renderScalingResults(null, summary, settings);
      renderScalingEvents(null);
      return;
    }
    scaling.error.textContent = "";
    const result = scalingState.pathPoints.length
      ? simulateScalingPath({ ...settings, levels: scalingState.levels, path: scalingState.pathPoints.map(({ price: value }) => value) })
      : null;
    renderScalingPath(result, bounds);
    renderScalingResults(result, summary, settings);
    renderScalingEvents(result);
  } catch (caught) {
    scaling.error.textContent = String(caught?.message ?? caught).toUpperCase();
    scaling.resultMetrics.innerHTML = "";
  }
}

function scalingBounds(summary, requestedRangePct) {
  const requestedDistance = summary.anchorPrice * requestedRangePct / 100;
  const prices = [summary.anchorPrice, ...summary.levels.map(({ price: value }) => value), summary.impliedStop].filter(Number.isFinite);
  const requiredDistance = Math.max(requestedDistance, ...prices.map((value) => Math.abs(value - summary.anchorPrice))) * 1.08;
  return { min: Math.max(summary.anchorPrice - requiredDistance, summary.anchorPrice * 0.001), max: summary.anchorPrice + requiredDistance };
}

function renderScalingPlanMetrics(summary) {
  scaling.planMetrics.innerHTML = [
    ["LOCKED ANCHOR", price(summary.anchorPrice)],
    ["PLANNED VALUE", money(summary.plannedNotional)],
    ["ALLOCATION LEFT", money(summary.remainingRisk)],
    ["TOTAL SHARES", number(summary.totalUnits, 6)],
    ["FULL-LADDER AVG", price(summary.averageEntry)],
    ["IMPLIED FULL STOP", price(summary.impliedStop)],
  ].map(metricMarkup).join("");
}

function metricMarkup([label, value]) {
  return `<span><small>${label}</small><strong>${value}</strong></span>`;
}

function renderScalingLadder(summary, bounds) {
  const top = 34;
  const bottom = 370;
  const center = 250;
  const barWidth = 220;
  const y = (value) => bottom - (value - bounds.min) / (bounds.max - bounds.min) * (bottom - top);
  const maxUnits = Math.max(...summary.levels.map(({ units }) => units), 1);
  const ticks = Array.from({ length: 7 }, (_, index) => bounds.max - (bounds.max - bounds.min) * index / 6);
  const rows = summary.levels.map((level) => {
    const favorable = summary.direction === "long" ? level.price > summary.anchorPrice : level.price < summary.anchorPrice;
    const adverse = summary.direction === "long" ? level.price < summary.anchorPrice : level.price > summary.anchorPrice;
    const levelClass = favorable ? "favorable" : adverse ? "adverse" : "anchor";
    const width = Math.max(8, level.units / maxUnits * barWidth);
    const selected = level.id === scalingState.selectedLevelId ? " selected" : "";
    return `<g class="scaling-level ${levelClass}${selected}" data-level-id="${level.id}">
      <line x1="${center}" y1="${y(level.price)}" x2="${center + width}" y2="${y(level.price)}" />
      <rect class="scaling-level-hit" x="${center + width - 24}" y="${y(level.price) - 24}" width="48" height="48" data-level-id="${level.id}" data-level-drag="units" />
      <rect class="scaling-level-handle" x="${center + width - 5}" y="${y(level.price) - 7}" width="10" height="14" data-level-id="${level.id}" data-level-drag="units"><title>DRAG HORIZONTALLY · ${number(level.units, 6)} SHARES</title></rect>
      <circle cx="${center}" cy="${y(level.price)}" r="7" data-level-id="${level.id}" data-level-drag="price"><title>DRAG VERTICALLY · ${price(level.price)}</title></circle>
      <text x="${center + width + 9}" y="${y(level.price) + 4}">${number(level.units, 4)}</text>
    </g>`;
  }).join("");
  scaling.ladder.innerHTML = `
    <g class="scaling-grid">${ticks.map((tick) => `<line x1="78" y1="${y(tick)}" x2="535" y2="${y(tick)}" /><text x="68" y="${y(tick) + 4}" text-anchor="end">${compactPrice(tick)}</text>`).join("")}</g>
    <line class="scaling-anchor-line" x1="78" y1="${y(summary.anchorPrice)}" x2="535" y2="${y(summary.anchorPrice)}" />
    <text class="scaling-anchor-label" x="82" y="${y(summary.anchorPrice) - 7}">CURRENT ${compactPrice(summary.anchorPrice)}</text>
    ${Number.isFinite(summary.impliedStop) ? `<line class="scaling-stop-line" x1="78" y1="${y(summary.impliedStop)}" x2="535" y2="${y(summary.impliedStop)}" /><text class="scaling-stop-label" x="532" y="${y(summary.impliedStop) - 7}" text-anchor="end">FULL-LADDER STOP ${compactPrice(summary.impliedStop)}</text>` : ""}
    <line class="scaling-lot-axis" x1="${center}" y1="${top}" x2="${center}" y2="${bottom}" />
    ${rows}`;
  scaling.ladder.dataset.minPrice = bounds.min;
  scaling.ladder.dataset.maxPrice = bounds.max;
  scaling.ladder.dataset.maxUnits = maxUnits * 2;
}

function renderScalingLevelList(summary) {
  const ordered = [...summary.levels].sort((left, right) => right.price - left.price);
  scaling.levelList.innerHTML = ordered.map((level) => {
    const relation = Math.abs(level.price - summary.anchorPrice) < 1e-9
      ? "AT MARK"
      : (summary.direction === "long" ? level.price > summary.anchorPrice : level.price < summary.anchorPrice) ? "FAVORABLE" : "ADVERSE";
    return `<div class="scaling-level-row ${level.id === scalingState.selectedLevelId ? "selected" : ""}" data-level-row="${level.id}">
      <button type="button" class="scaling-level-select" data-select-level="${level.id}" title="Select level"><i></i></button>
      <label>PRICE<input data-level-price="${level.id}" type="number" min="0.00000001" step="any" value="${level.price}" /></label>
      <label>SHARES<input data-level-units="${level.id}" type="number" min="0.00000001" step="any" value="${level.units}" /></label>
      <span><small>VALUE</small><strong>${money(level.price * level.units)}</strong><em>${relation}</em></span>
      <button type="button" class="icon-button" data-remove-level="${level.id}" aria-label="Remove level">×</button>
    </div>`;
  }).join("");
  scaling.levelList.querySelectorAll("[data-select-level]").forEach((button) => button.addEventListener("click", () => {
    scalingState.selectedLevelId = button.dataset.selectLevel;
    renderScaling();
  }));
}

function editScalingLevel(event) {
  const priceInput = event.target.closest("[data-level-price]");
  const unitsInput = event.target.closest("[data-level-units]");
  const id = priceInput?.dataset.levelPrice ?? unitsInput?.dataset.levelUnits;
  if (!id) return;
  const level = scalingState.levels.find((item) => item.id === id);
  const value = Number(event.target.value);
  if (!level || !Number.isFinite(value) || value <= 0) return;
  if (priceInput) level.price = value;
  if (unitsInput) level.units = value;
  scalingState.selectedLevelId = id;
  scheduleScalingRender();
}

function addScalingLevel() {
  const settings = scalingState.appliedSettings;
  const id = `level-${Date.now().toString(36)}`;
  scalingState.levels.push({ id, price: scalingState.anchorPrice, units: settings.startingLotUnits });
  scalingState.selectedLevelId = id;
  renderScaling();
}

function removeScalingLevel(id) {
  if (scalingState.levels.length <= 1) return;
  scalingState.levels = scalingState.levels.filter((level) => level.id !== id);
  if (scalingState.selectedLevelId === id) scalingState.selectedLevelId = scalingState.levels[0]?.id ?? "";
  renderScaling();
}

function applyScalingBatch(action) {
  if (!scalingState.levels.length) return;
  const settings = scalingState.appliedSettings;
  const ordered = [...scalingState.levels].sort((left, right) => Math.abs(left.price - scalingState.anchorPrice) - Math.abs(right.price - scalingState.anchorPrice));
  if (action === "space" && ordered.length > 1) scalingState.levels = evenlySpaceScalingLevels(scalingState.levels, scalingState.anchorPrice);
  if (action === "size") ordered.forEach((level) => { level.units = settings.startingLotUnits; });
  if (action === "front" || action === "back") {
    ordered.forEach((level, index) => {
      const rank = action === "front" ? ordered.length - 1 - index : index;
      level.units = settings.startingLotUnits * (1 + rank * 0.35);
    });
  }
  if (action === "normalize") {
    const total = ordered.reduce((sum, level) => sum + level.price * level.units, 0);
    if (total > 0) ordered.forEach((level) => { level.units *= settings.maxRisk / total; });
  }
  renderScaling();
}

function startLadderDrag(event) {
  const target = event.target.closest("[data-level-drag]");
  if (!target) return;
  event.preventDefault();
  const level = scalingState.levels.find(({ id }) => id === target.dataset.levelId);
  if (!level) return;
  const point = svgPoint(scaling.ladder, event);
  const minPrice = Number(scaling.ladder.dataset.minPrice);
  const maxPrice = Number(scaling.ladder.dataset.maxPrice);
  const maxUnits = Math.max(Number(scaling.ladder.dataset.maxUnits), level.units * 2);
  scalingState.selectedLevelId = target.dataset.levelId;
  scalingState.drag = {
    id: target.dataset.levelId,
    type: target.dataset.levelDrag,
    startPointerX: point.x,
    startPointerY: point.y,
    startPrice: level.price,
    startUnits: level.units,
    minPrice,
    maxPrice,
    pricePerSvgY: (maxPrice - minPrice) / ((370 - 34) * 4),
    minUnits: Math.max(maxUnits * 0.005, 1e-8),
    maxUnits,
    unitsPerSvgX: maxUnits / (220 * 8),
  };
  scaling.ladder.setPointerCapture(event.pointerId);
}

function moveLadderDrag(event) {
  if (!scalingState.drag) return;
  const point = svgPoint(scaling.ladder, event);
  const level = scalingState.levels.find(({ id }) => id === scalingState.drag.id);
  if (!level) return;
  if (scalingState.drag.type === "price") {
    level.price = priceFromDrag(scalingState.drag, point.y);
  } else {
    level.units = lotUnitsFromDrag(scalingState.drag, point.x);
  }
  scheduleScalingRender();
}

function endLadderDrag(event) {
  if (!scalingState.drag) return;
  scalingState.drag = null;
  if (scaling.ladder.hasPointerCapture(event.pointerId)) scaling.ladder.releasePointerCapture(event.pointerId);
  renderScaling();
}

function setPathMode(mode) {
  scalingState.pathMode = mode === "inspect" ? "inspect" : "draw";
  document.querySelectorAll("[data-path-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.pathMode === scalingState.pathMode)));
  scaling.path.classList.toggle("is-inspecting", scalingState.pathMode === "inspect");
}

function setPathPreset(preset, shouldRender = true) {
  const anchor = scalingState.anchorPrice;
  const range = readScalingSettings().rangePct / 100;
  const paths = {
    up: [0, 0.35, 0.75],
    down: [0, -0.35, -0.75],
    v: [0, -0.7, 0.65],
    "inverse-v": [0, 0.7, -0.65],
    chop: [0, -0.42, 0.25, -0.7, 0.72, -0.12],
  };
  if (preset === "clear") scalingState.pathPoints = [];
  else {
    const moves = paths[preset] ?? paths.chop;
    scalingState.pathPoints = moves.map((move, index) => ({ x: moves.length === 1 ? 0 : index / (moves.length - 1), price: Math.max(anchor * 0.001, anchor * (1 + range * move)) }));
  }
  scalingState.scrubIndex = null;
  if (shouldRender) renderScaling();
}

function startPathInteraction(event) {
  event.preventDefault();
  const pointNode = event.target.closest("[data-path-index]");
  if (pointNode) {
    const index = Number(pointNode.dataset.pathIndex);
    if (index === 0) return;
    scalingState.pathDrag = { type: "point", index };
  } else if (scalingState.pathMode === "inspect") {
    inspectPathAt(event);
    return;
  } else {
    const mapped = mapPathPointer(event);
    scalingState.pathPoints = [{ x: 0, price: scalingState.anchorPrice }];
    if (mapped.x > 0.006) scalingState.pathPoints.push(mapped);
    scalingState.pathDrag = { type: "draw" };
  }
  scaling.path.setPointerCapture(event.pointerId);
}

function movePathInteraction(event) {
  if (!scalingState.pathDrag) {
    if (scalingState.pathMode === "inspect") inspectPathAt(event);
    return;
  }
  const mapped = mapPathPointer(event);
  if (scalingState.pathDrag.type === "point") {
    const index = scalingState.pathDrag.index;
    const previousX = scalingState.pathPoints[index - 1]?.x ?? 0;
    const nextX = scalingState.pathPoints[index + 1]?.x ?? 1;
    scalingState.pathPoints[index] = { x: Math.max(previousX, Math.min(nextX, mapped.x)), price: mapped.price };
  } else {
    const previous = scalingState.pathPoints.at(-1);
    if (!previous || mapped.x - previous.x >= 0.006) scalingState.pathPoints.push({ x: Math.max(previous?.x ?? 0, mapped.x), price: mapped.price });
  }
  scheduleScalingRender();
}

function endPathInteraction(event) {
  if (!scalingState.pathDrag) return;
  scalingState.pathDrag = null;
  if (scaling.path.hasPointerCapture(event.pointerId)) scaling.path.releasePointerCapture(event.pointerId);
  renderScaling();
}

function mapPathPointer(event) {
  const point = svgPoint(scaling.path, event);
  const min = Number(scaling.path.dataset.minPrice);
  const max = Number(scaling.path.dataset.maxPrice);
  const x = Math.max(0, Math.min(1, (point.x - 70) / (830 - 70)));
  const priceValue = Math.max(min, Math.min(max, max - (point.y - 28) / (245 - 28) * (max - min)));
  return { x, price: priceValue };
}

function inspectPathAt(event) {
  if (!scalingState.pathPoints.length) return;
  const x = mapPathPointer(event).x;
  scalingState.scrubIndex = scalingState.pathPoints.reduce((best, point, index) => Math.abs(point.x - x) < Math.abs(scalingState.pathPoints[best].x - x) ? index : best, 0);
  scheduleScalingRender();
}

function renderScalingPath(result, bounds) {
  const left = 70;
  const right = 830;
  const priceTop = 28;
  const priceBottom = 245;
  const pnlTop = 285;
  const pnlBottom = 338;
  const x = (value) => left + value * (right - left);
  const priceY = (value) => priceBottom - (value - bounds.min) / (bounds.max - bounds.min) * (priceBottom - priceTop);
  const ticks = Array.from({ length: 6 }, (_, index) => bounds.max - (bounds.max - bounds.min) * index / 5);
  const pathLine = scalingState.pathPoints.map((point) => `${x(point.x)},${priceY(point.price)}`).join(" ");
  const maxAbsPnl = Math.max(1, ...(result?.timeline ?? []).map(({ pnl }) => Math.abs(pnl)));
  const pnlY = (value) => (pnlTop + pnlBottom) / 2 - value / maxAbsPnl * (pnlBottom - pnlTop) / 2;
  const pnlLine = result?.timeline.map((point, index) => `${x(scalingState.pathPoints[index]?.x ?? 0)},${pnlY(point.pnl)}`).join(" ") ?? "";
  const fillMarkers = (result?.events ?? []).map((event) => {
    const endIndex = Math.max(0, event.pathIndex);
    const startPoint = scalingState.pathPoints[Math.max(0, endIndex - 1)] ?? scalingState.pathPoints[0];
    const endPoint = scalingState.pathPoints[endIndex] ?? startPoint;
    const priceSpan = endPoint.price - startPoint.price;
    const fraction = Math.abs(priceSpan) < 1e-9 ? 1 : (event.price - startPoint.price) / priceSpan;
    const eventX = startPoint.x + (endPoint.x - startPoint.x) * Math.max(0, Math.min(1, fraction));
    return `<g class="scaling-path-event ${event.type}"><circle cx="${x(eventX)}" cy="${priceY(event.price)}" r="5"><title>${event.type.toUpperCase()} · ${price(event.price)} · ${signedMoney(event.pnl)}</title></circle></g>`;
  }).join("");
  const points = scalingState.pathPoints.map((point, index) => index === 0
    ? `<circle class="scaling-path-point locked" cx="${x(point.x)}" cy="${priceY(point.price)}" r="6"><title>LOCKED START · ${price(point.price)}</title></circle>`
    : `<circle class="scaling-path-hit" cx="${x(point.x)}" cy="${priceY(point.price)}" r="32" data-path-index="${index}" /><circle class="scaling-path-point" cx="${x(point.x)}" cy="${priceY(point.price)}" r="7" data-path-index="${index}"><title>POINT ${index + 1} · ${price(point.price)}</title></circle>`).join("");
  const scrubIndex = Math.min(scalingState.scrubIndex ?? -1, scalingState.pathPoints.length - 1);
  const scrub = scrubIndex >= 0 && result?.timeline[scrubIndex]
    ? `<g class="scaling-scrub"><line x1="${x(scalingState.pathPoints[scrubIndex].x)}" y1="${priceTop}" x2="${x(scalingState.pathPoints[scrubIndex].x)}" y2="${pnlBottom}" /><text x="${x(scalingState.pathPoints[scrubIndex].x) + 7}" y="20">${price(result.timeline[scrubIndex].price)} · ${signedMoney(result.timeline[scrubIndex].pnl)} · ${number(result.timeline[scrubIndex].units, 4)} SH</text></g>`
    : "";
  scaling.path.innerHTML = `
    <g class="scaling-grid">${ticks.map((tick) => `<line x1="${left}" y1="${priceY(tick)}" x2="${right}" y2="${priceY(tick)}" /><text x="${left - 9}" y="${priceY(tick) + 4}" text-anchor="end">${compactPrice(tick)}</text>`).join("")}<line x1="${left}" y1="${(pnlTop + pnlBottom) / 2}" x2="${right}" y2="${(pnlTop + pnlBottom) / 2}" /><text x="${left - 9}" y="${(pnlTop + pnlBottom) / 2 + 4}" text-anchor="end">P/L 0</text></g>
    ${pathLine ? `<polyline class="scaling-path-line" points="${pathLine}" />` : `<text class="scaling-empty-label" x="450" y="135" text-anchor="middle">DRAW LEFT TO RIGHT</text>`}
    ${pnlLine ? `<polyline class="scaling-pnl-line" points="${pnlLine}" />` : ""}
    ${fillMarkers}${points}${scrub}`;
  scaling.path.dataset.minPrice = bounds.min;
  scaling.path.dataset.maxPrice = bounds.max;
}

function renderScalingResults(result, summary, settings) {
  if (!result) {
    scaling.resultMetrics.innerHTML = "";
    return;
  }
  const startingLevel = [...summary.levels].sort((left, right) => Math.abs(left.price - summary.anchorPrice) - Math.abs(right.price - summary.anchorPrice))[0];
  const single = simulateComparison(settings, [startingLevel]);
  const allNowUnits = summary.plannedNotional / summary.anchorPrice;
  const allNow = simulateComparison(settings, [{ id: "all-now", price: summary.anchorPrice, units: allNowUnits }]);
  scaling.resultMetrics.innerHTML = [
    ["MARK P/L", signedMoney(result.ending.pnl)],
    ["NET IF CLOSED", signedMoney(result.ending.closePnl)],
    ["ENDING SHARES", number(result.ending.units, 6)],
    ["AVERAGE ENTRY", price(result.ending.averageEntry)],
    ["CAPITAL USED", money(result.ending.deployedNotional)],
    ["MAX DRAWDOWN", money(result.maxDrawdown)],
    ["FEES", money(result.totalFees)],
    ["VS STARTING LOT", signedMoney(result.ending.pnl - (single?.ending.pnl ?? 0))],
    ["VS ALL-IN NOW", signedMoney(result.ending.pnl - (allNow?.ending.pnl ?? 0))],
  ].map(metricMarkup).join("");
}

function simulateComparison(settings, levels) {
  try {
    return simulateScalingPath({ ...settings, maxRisk: Math.max(settings.maxRisk, levels.reduce((sum, level) => sum + level.price * level.units, 0)), levels, path: scalingState.pathPoints.map(({ price: value }) => value) });
  } catch {
    return null;
  }
}

function renderScalingEvents(result) {
  if (!result?.events.length) {
    scaling.events.innerHTML = '<p class="hint">NO LEVELS CROSSED.</p>';
    return;
  }
  scaling.events.innerHTML = `<table class="paper-table"><thead><tr><th>#</th><th>EVENT</th><th>PRICE</th><th>SHARES</th><th>VALUE</th><th>AVG ENTRY</th><th>POSITION</th><th>P/L</th><th>FEE</th></tr></thead><tbody>${result.events.map((event) => `<tr><td>${event.sequence}</td><td>${event.type === "stop" ? "MAX LOSS STOP" : event.action}</td><td>${price(event.price)}</td><td>${number(event.fillUnits, 6)}</td><td>${money(event.fillNotional)}</td><td>${price(event.averageEntry)}</td><td>${number(event.units, 6)}</td><td>${signedMoney(event.pnl)}</td><td>${money(event.fee)}</td></tr>`).join("")}</tbody></table>`;
}

function svgPoint(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function compactPrice(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: Math.abs(Number(value)) < 1 ? 4 : 2 });
}
