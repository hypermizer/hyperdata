export function heatMapTone(changePercent) {
  if (changePercent === null || changePercent === undefined || changePercent === "") {
    return { direction: "neutral", intensity: "unavailable" };
  }
  const change = Number(changePercent);
  if (!Number.isFinite(change)) return { direction: "neutral", intensity: "unavailable" };
  if (change === 0) return { direction: "neutral", intensity: "flat" };

  const magnitude = Math.abs(change);
  let intensity = "extreme";
  if (magnitude < 0.5) intensity = "subtle";
  else if (magnitude < 2) intensity = "medium";
  else if (magnitude < 4) intensity = "strong";
  return { direction: change > 0 ? "positive" : "negative", intensity };
}

export function watchedHeatMapMarkets(markets, watchedAssets) {
  const watched = new Set(watchedAssets);
  return markets
    .filter((market) => watched.has(market.id))
    .sort((left, right) => {
      const leftValue = left.changePercent;
      const rightValue = right.changePercent;
      const leftMove = leftValue === null || leftValue === undefined || String(leftValue).trim() === ""
        ? -1
        : Number.isFinite(Number(leftValue)) ? Math.abs(Number(leftValue)) : -1;
      const rightMove = rightValue === null || rightValue === undefined || String(rightValue).trim() === ""
        ? -1
        : Number.isFinite(Number(rightValue)) ? Math.abs(Number(rightValue)) : -1;
      return rightMove - leftMove || left.id.localeCompare(right.id);
    });
}

export function watchedHeatMapTiles(markets, watchedAssets) {
  return watchedHeatMapMarkets(markets, watchedAssets).map((market) => ({
    market,
    tone: heatMapTone(market.changePercent),
  }));
}

export function focusedHeatMapAsset(container, activeElement) {
  if (!activeElement || !container.contains(activeElement)) return null;
  return activeElement.dataset?.heatMapAsset ?? null;
}

export function restoreHeatMapFocus(container, asset) {
  if (!asset) return;
  const tile = [...container.querySelectorAll("[data-heat-map-asset]")]
    .find((candidate) => candidate.dataset.heatMapAsset === asset);
  tile?.focus({ preventScroll: true });
}
