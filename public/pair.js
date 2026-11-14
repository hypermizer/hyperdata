import { AssetPicker } from "./asset-picker.js?v=20261114-pair2";
import { createPairMonitor } from "./pair-monitor.js?v=20261114-pair2";
import { pairViewPreferences } from "./lib/pair-chart.js?v=20261114-pair2";
const CACHE = "hyperdata.pair.view.v2";
export function createPairView({ client, getCatalog }) {
  const $ = (id) => document.getElementById("pair-" + id),
    pickers = [
      new AssetPicker($("picker-a"), { details: "venue" }),
      new AssetPicker($("picker-b"), { details: "venue" }),
    ];
  let cached = {};
  try {
    cached = JSON.parse(localStorage.getItem(CACHE) ?? "{}");
  } catch { /* server restore */ }
  let prefs = pairViewPreferences(cached.settings),
    dirty = cached.dirty === true,
    revision = 0,
    owner = null,
    restored = false,
    initialized = false,
    active = false,
    catalog = null,
    saveTimer = null,
    saving = false,
    monitor;
  function cache() {
    try {
      localStorage.setItem(CACHE, JSON.stringify({ settings: prefs, dirty }));
    } catch { /* server remains authoritative */ }
  }
  function update(delta) {
    const next = pairViewPreferences({ ...prefs, ...delta });
    if (JSON.stringify(next) === JSON.stringify(prefs)) return;
    prefs = next;
    dirty = true;
    revision++;
    cache();
    $("save-status").textContent = "SAVING…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  }
  async function save() {
    if (!dirty || !restored || !owner || saving) return;
    saving = true;
    const version = revision;
    try {
      const r = await client.from("pair_view_preferences").upsert({
        user_id: owner,
        settings: prefs,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (r.error) throw r.error;
      if (version === revision) {
        dirty = false;
        cache();
        $("save-status").textContent = "SAVED";
      }
    } catch {
      $("save-status").textContent = "SAVED IN BROWSER · SERVER RETRYING";
    } finally {
      saving = false;
      if (dirty) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 10000);
      }
    }
  }
  function catalogReady() {
    const list = getCatalog();
    if (list.length && list !== catalog) {
      const firstCatalog = !catalog;
      catalog = list;
      pickers.forEach((p) => p.setCatalog(list));
      if (firstCatalog) {
        pickers[0].select(prefs.assetA);
        pickers[1].select(prefs.assetB);
      }
    }
    const available = Boolean(
      catalog?.some((a) => a.id === prefs.assetA) &&
        catalog.some((a) => a.id === prefs.assetB) &&
        prefs.assetA !== prefs.assetB,
    );
    pickers.forEach((p) => p.setDisabled(!initialized || !catalog?.length));
    $("import").disabled = !initialized || !available;
    $("manual").disabled = !initialized || !available;
  }
  async function restore() {
    try {
      const s = await client.auth.getSession();
      owner = s.data.session?.user.id;
      if (!owner) throw Error("Private owner session unavailable");
      const r = await client.from("pair_view_preferences").select("settings")
        .eq("user_id", owner).maybeSingle();
      if (r.error) throw r.error;
      if (!dirty && r.data) prefs = pairViewPreferences(r.data.settings);
      else if (!r.data && !cached.settings) {
        const legacy = await client.from("comparison_preferences").select(
          "settings",
        ).eq("user_id", owner).maybeSingle();
        if (!legacy.error && legacy.data) {
          prefs = pairViewPreferences({
            assetA: legacy.data.settings.assetA,
            assetB: legacy.data.settings.assetB,
          });
        }
        try {
          prefs.selectedPairId = localStorage.getItem(
            "hyperdata.pair.selected.v1",
          );
        } catch { /* optional migration */ }
      }
      initialized = true;
      restored = true;
      cache();
      pickers[0].select(prefs.assetA);
      pickers[1].select(prefs.assetB);
      catalogReady();
      $("save-status").textContent = dirty ? "SAVING…" : "SAVED";
      monitor.setActive(active);
      monitor.settingsChanged();
      void save();
    } catch {
      initialized = true;
      catalogReady();
      $("save-status").textContent = "PRIVATE SETTINGS UNAVAILABLE · RETRYING";
      monitor.setActive(active);
      setTimeout(restore, 15000);
    }
  }
  monitor = createPairMonitor({
    client,
    getCatalog,
    getSettings: () => structuredClone(prefs),
    updateSettings: update,
    onSelect: (pair) => {
      update({ assetA: pair.assetA, assetB: pair.assetB });
      pickers[0].select(pair.assetA);
      pickers[1].select(pair.assetB);
      catalogReady();
    },
  });
  for (const [index, picker] of pickers.entries()) {
    picker.root.addEventListener("assetchange", ({ detail }) => {
      if (detail.assetId) {
        update({ [index === 0 ? "assetA" : "assetB"]: detail.assetId });
        catalogReady();
      }
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void save();
  });
  setInterval(() => {
    if (active) catalogReady();
  }, 1000);
  void restore();
  return {
    setActive(next) {
      catalogReady();
      document.querySelector("main").classList.toggle("pair-open", next);
      if (active === next) return;
      active = next;
      if (initialized) monitor.setActive(next);
      if (!next) void save();
    },
  };
}
