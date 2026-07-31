const SITE_VIEWS = new Set(["watchlist", "alerts", "audio", "analysis", "paper", "strats", "tools"]);
const PAPER_VIEWS = new Set(["home", "order"]);
const TOOLS_VIEWS = new Set(["exposure-ladder"]);
const CANDLE_INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"]);

export function parseRoute(hash) {
  const [view = "", nestedView = "", detailView = ""] = String(hash ?? "").replace(/^#\/?/, "").split("/");
  if (view === "assets" && nestedView) {
    try {
      const asset = decodeURIComponent(nestedView).trim();
      if (asset) return { view: "asset", asset, interval: CANDLE_INTERVALS.has(detailView) ? detailView : "1h", paperView: "home", toolsView: "exposure-ladder" };
    } catch {
      return { view: "watchlist", paperView: "home", toolsView: "exposure-ladder" };
    }
  }
  if (!SITE_VIEWS.has(view)) return { view: "watchlist", paperView: "home", toolsView: "exposure-ladder" };
  return {
    view,
    paperView: view === "paper" && PAPER_VIEWS.has(nestedView) ? nestedView : "home",
    toolsView: view === "tools" && TOOLS_VIEWS.has(nestedView) ? nestedView : "exposure-ladder",
  };
}

export function routeFor(view, nestedView = "home", detailView = "exposure-ladder") {
  if (view === "asset") return nestedView ? `#/assets/${encodeURIComponent(nestedView)}/${CANDLE_INTERVALS.has(detailView) ? detailView : "1h"}` : "#/watchlist";
  if (view === "paper") return `#/paper/${PAPER_VIEWS.has(nestedView) ? nestedView : "home"}`;
  if (view === "tools") return `#/tools/${TOOLS_VIEWS.has(detailView) ? detailView : "exposure-ladder"}`;
  return `#/${SITE_VIEWS.has(view) ? view : "watchlist"}`;
}
