const SITE_VIEWS = new Set(["watchlist", "charts", "compare", "alerts", "audio", "analysis", "paper", "principles"]);
const ANALYSIS_VIEWS = new Set(["trade-log"]);
const PAPER_VIEWS = new Set(["home", "order"]);
const CANDLE_INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"]);
const ASSET_VIEWS = new Set(["overview", "news", "financials"]);

export function parseRoute(hash) {
  let [view = "", nestedView = "", detailView = "", leafView = ""] = String(hash ?? "").replace(/^#\/?/, "").split("/");
  if (view === "heat-map") view = "charts";
  if (view === "assets" && nestedView) {
    try {
      const asset = decodeURIComponent(nestedView).trim();
      if (asset) {
        const legacyInterval = CANDLE_INTERVALS.has(detailView) ? detailView : null;
        const assetView = ASSET_VIEWS.has(detailView) ? detailView : "overview";
        const interval = legacyInterval ?? (CANDLE_INTERVALS.has(leafView) ? leafView : "1h");
        return { view: "asset", asset, assetView, interval, analysisView: "trade-log", paperView: "home" };
      }
    } catch {
      return { view: "watchlist", analysisView: "trade-log", paperView: "home" };
    }
  }
  if (!SITE_VIEWS.has(view)) return { view: "watchlist", analysisView: "trade-log", paperView: "home" };
  return {
    view,
    analysisView: view === "analysis" && ANALYSIS_VIEWS.has(nestedView) ? nestedView : "trade-log",
    paperView: view === "paper" && PAPER_VIEWS.has(nestedView) ? nestedView : "home",
  };
}

export function routeFor(view, nestedView = "home", detailView = "overview", leafView = "1h") {
  if (view === "asset") {
    if (!nestedView) return "#/watchlist";
    const assetView = ASSET_VIEWS.has(detailView) ? detailView : "overview";
    const interval = CANDLE_INTERVALS.has(detailView) ? detailView : (CANDLE_INTERVALS.has(leafView) ? leafView : "1h");
    const suffix = assetView === "overview" ? `/overview/${interval}` : `/${assetView}`;
    return `#/assets/${encodeURIComponent(nestedView)}${suffix}`;
  }
  if (view === "paper") return `#/paper/${PAPER_VIEWS.has(nestedView) ? nestedView : "home"}`;
  if (view === "analysis") return `#/analysis/${ANALYSIS_VIEWS.has(nestedView) ? nestedView : "trade-log"}`;
  if (view === "heat-map") return "#/charts";
  return `#/${SITE_VIEWS.has(view) ? view : "watchlist"}`;
}
