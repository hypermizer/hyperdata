const SITE_VIEWS = new Set(["watchlist", "alerts", "audio", "analysis", "paper", "strats", "tools"]);
const PAPER_VIEWS = new Set(["home", "order"]);
const TOOLS_VIEWS = new Set(["exposure-ladder"]);

export function parseRoute(hash) {
  const [view = "", nestedView = ""] = String(hash ?? "").replace(/^#\/?/, "").split("/");
  if (!SITE_VIEWS.has(view)) return { view: "watchlist", paperView: "home", toolsView: "exposure-ladder" };
  return {
    view,
    paperView: view === "paper" && PAPER_VIEWS.has(nestedView) ? nestedView : "home",
    toolsView: view === "tools" && TOOLS_VIEWS.has(nestedView) ? nestedView : "exposure-ladder",
  };
}

export function routeFor(view, paperView = "home", toolsView = "exposure-ladder") {
  if (view === "paper") return `#/paper/${PAPER_VIEWS.has(paperView) ? paperView : "home"}`;
  if (view === "tools") return `#/tools/${TOOLS_VIEWS.has(toolsView) ? toolsView : "exposure-ladder"}`;
  return `#/${SITE_VIEWS.has(view) ? view : "watchlist"}`;
}
