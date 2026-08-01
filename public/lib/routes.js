const SITE_VIEWS = new Set(["watchlist", "alerts", "audio", "analysis", "paper", "strats", "tools"]);
const PAPER_VIEWS = new Set(["home", "order"]);
const TOOLS_VIEWS = new Set(["scaling"]);
const CANDLE_INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"]);
const ASSET_VIEWS = new Set(["overview", "news", "financials"]);

export function parseRoute(hash) {
  const [view = "", nestedView = "", detailView = "", leafView = ""] = String(hash ?? "").replace(/^#\/?/, "").split("/");
  if (view === "assets" && nestedView) {
    try {
      const asset = decodeURIComponent(nestedView).trim();
      if (asset) {
        const legacyInterval = CANDLE_INTERVALS.has(detailView) ? detailView : null;
        const assetView = ASSET_VIEWS.has(detailView) ? detailView : "overview";
        const interval = legacyInterval ?? (CANDLE_INTERVALS.has(leafView) ? leafView : "1h");
        return { view: "asset", asset, assetView, interval, paperView: "home", toolsView: "scaling" };
      }
    } catch {
      return { view: "watchlist", paperView: "home", toolsView: "scaling" };
    }
  }
  if (!SITE_VIEWS.has(view)) return { view: "watchlist", paperView: "home", toolsView: "scaling" };
  return {
    view,
    paperView: view === "paper" && PAPER_VIEWS.has(nestedView) ? nestedView : "home",
    toolsView: view === "tools" && TOOLS_VIEWS.has(nestedView) ? nestedView : "scaling",
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
  if (view === "tools") return `#/tools/${TOOLS_VIEWS.has(detailView) ? detailView : "scaling"}`;
  return `#/${SITE_VIEWS.has(view) ? view : "watchlist"}`;
}
