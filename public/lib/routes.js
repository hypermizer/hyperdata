const SITE_VIEWS = new Set(["watchlist", "alerts", "audio", "analysis", "paper"]);
const PAPER_VIEWS = new Set(["home", "order"]);

export function parseRoute(hash) {
  const [view = "", paperView = ""] = String(hash ?? "").replace(/^#\/?/, "").split("/");
  if (!SITE_VIEWS.has(view)) return { view: "watchlist", paperView: "home" };
  return {
    view,
    paperView: view === "paper" && PAPER_VIEWS.has(paperView) ? paperView : "home",
  };
}

export function routeFor(view, paperView = "home") {
  if (view === "paper") return `#/paper/${PAPER_VIEWS.has(paperView) ? paperView : "home"}`;
  return `#/${SITE_VIEWS.has(view) ? view : "watchlist"}`;
}
