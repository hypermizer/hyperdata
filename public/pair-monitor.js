import {
  accountPairCurve,
  manualPairCurve,
  normalizePair,
  pairAccountState,
  pairValuation,
  replayPairLeg,
} from "./lib/pair-trade.js?v=20261114-monitor1";
const dollars = (value) =>
  value == null ? "—" : new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(value));
const pct = (value) => value == null ? "—" : Number(value).toFixed(2);
const number = (value) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 9 }).format(
      Number(value),
    );
const date = (value) =>
  new Date(value).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const utcInput = (value) => new Date(value).toISOString().slice(0, 19);

export function createPairMonitor(
  { client, getCatalog, getSettings, onSelect },
) {
  const root = document.getElementById("pair-monitor");
  root.innerHTML =
    `<div class="pair-toolbar"><label>SAVED TRADE <select id="pair-select"><option value="">No trade selected</option></select></label><button id="pair-import" type="button">IMPORT LINKED POSITIONS</button><button id="pair-manual" type="button">NEW MANUAL TRADE</button><button id="pair-edit" type="button" hidden>EDIT / ALERTS</button><button id="pair-archive" type="button" hidden>ARCHIVE</button></div><p id="pair-message" class="hint" role="status">Import your linked Hyperliquid positions, or enter a trade manually. Monitoring never places orders.</p><div id="pair-summary" hidden><div class="pair-metrics" id="pair-metrics"></div><p id="pair-freshness" class="hint"></p><details id="pair-details"><summary>POSITIONS, COSTS & RISK</summary><div id="pair-legs" class="pair-legs"></div><p id="pair-costs" class="hint"></p><p class="hint">Liquidation prices come from Hyperliquid. Cross-margin risk depends on the whole account and can change as collateral and other positions change. Leverage changes margin requirements; price P&amp;L uses signed quantity × price change.</p></details><details id="pair-pnl-details"><summary>PAIR P&amp;L HISTORY · USD</summary><p id="pair-pnl-status" class="hint" role="status"></p><div id="pair-pnl-chart" class="pair-pnl-chart" aria-label="Pair profit and loss history"></div></details></div><dialog id="pair-editor"><form id="pair-editor-form"><h3 id="pair-editor-title">PAIR TRADE</h3><label>NAME <input name="name" required maxlength="80" /></label><label>TRADE ENTRY · UTC <input name="openedAt" type="datetime-local" step="1" required /></label><div id="pair-editor-legs" class="pair-legs"></div><fieldset id="pair-manual-costs"><legend>ACTUAL CUMULATIVE COSTS · USD</legend><p class="hint">Leave unknown amounts empty. Enter 0 only when verified zero. Funding is signed cash received (+) or paid (−). Update these totals after fills or funding payments.</p><label>FEES PAID <input name="fees" type="number" step="any" /></label><label>FUNDING RECEIVED / PAID <input name="funding" type="number" step="any" /></label><label>REALIZED P&amp;L <input name="realized" type="number" step="any" /></label></fieldset><fieldset><legend>OPTIONAL PAIR ALERTS · NTFY ONLY</legend><p class="hint">Blank = off. Alerts trigger on a threshold crossing, with a 30-minute cooldown and at most four per metric per day. Three clear observations rearm a threshold. No recovery notifications.</p><label>NET PROFIT ≥ USD <input name="profit" type="number" min="0.01" step="any" /></label><label>NET LOSS ≥ USD <input name="loss" type="number" min="0.01" step="any" /></label><label>NEAREST LIQUIDATION BUFFER ≤ % <input name="liquidation" type="number" min="0.01" step="any" /></label><label>ABSOLUTE NET / GROSS EXPOSURE ≥ % <input name="exposure" type="number" min="0.01" max="100" step="any" /></label></fieldset><p id="pair-editor-error" class="message" role="alert"></p><div class="pair-toolbar"><button type="submit">SAVE TRADE</button><button id="pair-editor-cancel" type="button">CANCEL</button></div></form></dialog>`;
  const $ = (id) => document.getElementById("pair-" + id),
    form = $("editor-form");
  let active = false,
    owner = null,
    records = [],
    selected = null,
    snapshot = null,
    account = null,
    value = null,
    marks = {},
    socket = null,
    lastFrame = 0,
    lastPing = 0,
    retryAt = 0,
    backoff = 1000,
    lastRefresh = 0,
    refreshBusy = false,
    chart = null,
    lines = [],
    historyRows = [],
    historyBusy = false,
    lastHistory = 0,
    editing = null,
    version = 0;
  let lastChartTime = 0;
  let savedId = null;
  try {
    savedId = localStorage.getItem("hyperdata.pair.selected.v1");
  } catch { /* optional browser selection */ }
  const settings = () => getSettings();
  const selectedAssets = () =>
    selected
      ? [selected.config.assetA, selected.config.assetB]
      : [settings().assetA, settings().assetB];
  function message(text) {
    $("message").textContent = text;
  }
  function choose(id) {
    selected = records.find((r) => r.id === id) ?? null;
    savedId = selected?.id ?? null;
    try {
      if (savedId) localStorage.setItem("hyperdata.pair.selected.v1", savedId);
      else localStorage.removeItem("hyperdata.pair.selected.v1");
    } catch { /* saved configurations remain on server */ }
    $("select").value = savedId ?? "";
    $("summary").hidden = !selected;
    $("edit").hidden = !selected;
    $("archive").hidden = !selected;
    version++;
    snapshot = null;
    account = null;
    value = null;
    marks = {};
    historyRows = [];
    lastHistory = 0;
    closeStream();
    disposeChart();
    if (selected) {
      message(
        `${
          selected.config.source === "account" ? "LINKED ACCOUNT" : "MANUAL"
        } · ${selected.config.name} · trade entry ${
          date(selected.config.openedAt)
        }. Chart rebasing does not change trade cost basis. ${
          Object.keys(selected.config.alerts ?? {}).length
            ? "NTFY ALERTS: " +
              Object.keys(selected.config.alerts).join(", ").toUpperCase()
            : "NTFY ALERTS OFF"
        }.`,
      );
      onSelect?.(selected.config);
      void refresh();
      connect();
    } else {message(
        "Import your linked Hyperliquid positions, or enter a trade manually. Monitoring never places orders.",
      );}
  }
  async function list() {
    const session = await client.auth.getSession();
    owner = session.data.session?.user.id;
    if (!owner) throw Error("Private owner session unavailable");
    const response = await client.from("pair_trades").select("*").eq(
      "archived",
      false,
    ).order("created_at");
    if (response.error) throw response.error;
    records = response.data ?? [];
    const select = $("select");
    select.replaceChildren(el("option", "No trade selected"));
    select.firstChild.value = "";
    for (const row of records) {
      const option = el("option", row.config.name);
      option.value = row.id;
      select.append(option);
    }
    choose(savedId);
  }
  async function readSnapshot(assets) {
    const r = await client.rpc("pair_account_snapshot", { p_assets: assets });
    if (r.error) throw Error(r.error.message);
    return r.data;
  }
  async function refresh() {
    if (!selected || refreshBusy || !active || document.hidden) return;
    refreshBusy = true;
    const token = version, assets = selectedAssets();
    try {
      const data = await readSnapshot(assets);
      if (token !== version) return;
      snapshot = data;
      account = pairAccountState(data);
      for (const quote of data.marks ?? []) {
        if (
          !marks[quote.asset] ||
          Date.parse(quote.observed_at) > marks[quote.asset].time
        ) {
          marks[quote.asset] = {
            price: quote.mark_price,
            time: Date.parse(quote.observed_at),
          };
        }
      }
      lastRefresh = Date.now();
      render();
      if ($("pnl-details").open) void loadHistory();
    } catch (error) {
      if (token === version) {
        $("freshness").textContent =
          `ACCOUNT DATA UNAVAILABLE · ${error.message}`;
      }
    } finally {
      refreshBusy = false;
    }
  }
  function render() {
    if (!selected || !account) return;
    try {
      const fresh = selectedAssets().every((asset) =>
        marks[asset] && Date.now() - marks[asset].time < 15000
      );
      const venues = selectedAssets().map((asset) =>
        asset.includes(":") ? asset.split(":")[0] : ""
      );
      account = pairAccountState(snapshot);
      const state = {
        ...account,
        accountFresh: account.accountFresh &&
          venues.every((dex) => account.freshDexes.has(dex)),
        marksFresh: fresh,
      };
      value = pairValuation(
        selected.config,
        Object.fromEntries(
          Object.entries(marks).map(([asset, q]) => [asset, q.price]),
        ),
        state,
      );
      const metrics = $("metrics");
      metrics.replaceChildren();
      for (
        const [label, amount, note] of [
          [
            value.net === null ? "GROSS UNREALIZED P&L" : "NET PAIR P&L",
            dollars(value.net ?? value.unrealized),
            value.net === null
              ? "Costs or account history incomplete"
              : `Includes realized P&L, fees & funding${
                value.fresh ? "" : " · STALE"
              }`,
          ],
          [
            "LONG / SHORT NOTIONAL",
            `${dollars(value.long)} / ${dollars(value.short)}`,
            `Short / long ratio ${(value.hedgeRatio == null
              ? "—"
              : Number(value.hedgeRatio).toFixed(3))}`,
          ],
          [
            "NET EXPOSURE",
            dollars(value.netExposure),
            `${pct(value.exposurePercent)}% of gross exposure`,
          ],
          [
            "NEAREST LIQUIDATION",
            value.liquidationBuffer === null
              ? "—"
              : `${pct(value.liquidationBuffer)}%`,
            "Distance at current mark · account estimate",
          ],
        ]
      ) {
        const card = el("div", null, "pair-metric");
        card.append(
          el("span", label, "hint"),
          el("strong", amount),
          el("small", note, "hint"),
        );
        metrics.append(card);
      }
      const ages = selectedAssets().map((asset) =>
        `${asset} mark ${
          marks[asset]
            ? Math.floor((Date.now() - marks[asset].time) / 1000) + "s old"
            : "unavailable"
        }`
      );
      $("freshness").textContent = `${
        value.fresh
          ? "LIVE MARK VALUATION"
          : "STALE / INCOMPLETE · ALERTS WITHHELD"
      } · ${ages.join(" · ")} · server monitor ${
        selectedAssets().every((asset) =>
            (snapshot.marks ?? []).some((q) =>
              q.asset === asset &&
              Date.now() - Date.parse(q.observed_at) < 30000
            )
          )
          ? "current"
          : "awaiting fresh data"
      }${
        snapshot.source
          ? ` · fills/funding sync ${
            snapshot.source.last_success_at
              ? date(snapshot.source.last_success_at)
              : "never"
          }`
          : ""
      }${
        value.legs.some((leg) => !leg.reconciled)
          ? " · position has unreconciled fills; net P&L unavailable"
          : ""
      }`;
      if (chart && value.fresh) {
        const time = Math.floor(Date.now() / 1000);
        if (time >= lastChartTime) {
          if (selected.config.source === "account" && value.net !== null) {
            const values = [...value.legs.map((l) => l.net), value.net];
            lines.forEach((line, i) => {
              if (values[i] != null) {
                line.update({ time, value: Number(values[i]) });
              }
            });
          } else if (
            selected.config.source === "manual" && value.unrealized !== null
          ) lines[0]?.update({ time, value: Number(value.unrealized) });
          lastChartTime = time;
        }
      }
      $("summary").dataset.net = value.net ?? "";
      $("summary").dataset.fresh = String(value.fresh);
      $("summary").dataset.source = selected.config.source;
      $("legs").replaceChildren();
      for (const leg of value.legs) {
        const card = el("div", null, "pair-leg");
        card.append(
          el(
            "h3",
            `${leg.asset} · ${leg.side.toUpperCase()}${
              Number(leg.quantity) === 0 ? " · CLOSED" : ""
            }`,
          ),
        );
        for (
          const [label, amount] of [
            ["Quantity", number(leg.quantity)],
            ["Average entry", dollars(leg.entry)],
            ["Mark", dollars(leg.mark)],
            ["Notional", dollars(leg.notional)],
            ["Unrealized P&L", dollars(leg.unrealized)],
            [
              "Leverage / margin",
              `${number(leg.leverage)}× ${leg.marginMode ?? "unknown"}`,
            ],
            ["Margin used", dollars(leg.margin)],
            ["Liquidation price", dollars(leg.liquidation)],
            [
              "Liquidation buffer",
              leg.distance === null ? "—" : pct(leg.distance) + "%",
            ],
          ]
        ) {
          const row = el("div", null, "pair-detail-row");
          row.append(el("span", label), el("strong", amount));
          card.append(row);
        }
        $("legs").append(card);
      }
      $("costs").textContent = `${
        value.costsComplete
          ? "RECONCILED ACTUAL TOTALS"
          : "DATA OR COSTS INCOMPLETE · NET P&L UNAVAILABLE"
      } · Realized ${dollars(value.realized)} · fees ${
        dollars(value.fees)
      } · signed funding ${dollars(value.funding)}. ${
        selected.config.source === "account"
          ? "Totals belong to the imported position episodes, including partial closes."
          : "Manual totals are not updated automatically; the history chart shows gross price P&L because cost timing is unknown."
      }`;
    } catch (error) {
      $("freshness").textContent = `VALUATION UNAVAILABLE · ${error.message}`;
      value = null;
    }
  }
  function closeStream() {
    const old = socket;
    socket = null;
    old?.close();
  }
  function connect() {
    if (
      !active || !selected || socket || document.hidden || Date.now() < retryAt
    ) return;
    const token = version, ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
    socket = ws;
    lastFrame = Date.now();
    ws.onopen = () => {
      if (token !== version) return;
      for (const asset of selectedAssets()) {
        ws.send(
          JSON.stringify({
            method: "subscribe",
            subscription: { type: "activeAssetCtx", coin: asset },
          }),
        );
      }
    };
    ws.onmessage = ({ data }) => {
      if (token !== version || socket !== ws) return;
      try {
        const msg = JSON.parse(data);
        lastFrame = Date.now();
        backoff = 1000;
        if (
          msg.channel !== "activeAssetCtx" ||
          !selectedAssets().includes(msg.data?.coin)
        ) return;
        const amount = msg.data.ctx?.markPx;
        if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return;
        marks[msg.data.coin] = { price: amount, time: Date.now() };
        render();
      } catch { /* malformed frames cannot replace marks */ }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      retryAt = Date.now() + backoff;
      backoff = Math.min(30000, backoff * 2);
    };
    ws.onerror = () => ws.close();
  }
  function legEditor(leg, index, asset, locked) {
    const fieldset = el("fieldset");
    fieldset.append(el("legend", `${asset} · LEG ${index + 1}`));
    for (
      const [key, label, type] of [
        ["side", "DIRECTION", "select"],
        ["quantity", "QUANTITY", "number"],
        ["entry", "AVERAGE ENTRY PRICE", "number"],
        ["leverage", "LEVERAGE", "number"],
        ["marginMode", "MARGIN MODE", "select"],
      ]
    ) {
      const labelNode = el("label", label + " "),
        input = el(type === "select" ? "select" : "input");
      input.name = key + index;
      if (type === "select") {
        for (
          const v of key === "side" ? ["long", "short"] : ["isolated", "cross"]
        ) {
          const option = el("option", v.toUpperCase());
          option.value = v;
          input.append(option);
        }
      } else {
        input.type = type;
        input.required = true;
        input.min = key === "leverage" ? "1" : "0.000000000001";
        input.step = key === "leverage" ? "1" : "any";
        if (key === "leverage") {
          input.max = String(
            getCatalog().find((row) => row.id === asset)?.maxLeverage ?? 100,
          );
        }
      }
      input.value = leg[key];
      input.disabled = locked;
      labelNode.append(input);
      fieldset.append(labelNode);
    }
    return fieldset;
  }
  function editor(config, id = null) {
    editing = { config: structuredClone(config), id };
    $("editor-title").textContent = config.source === "account"
      ? "LINKED POSITION MONITOR"
      : "MANUAL POSITION MONITOR";
    form.elements.name.value = config.name;
    form.elements.openedAt.value = utcInput(config.openedAt);
    form.elements.openedAt.disabled = config.source === "account";
    $("editor-legs").replaceChildren(
      ...config.legs.map((leg, i) =>
        legEditor(
          leg,
          i,
          i ? config.assetB : config.assetA,
          config.source === "account",
        )
      ),
    );
    $("manual-costs").hidden = config.source === "account";
    for (const key of ["fees", "funding", "realized"]) {
      form.elements[key].value = config.costs?.[key] ?? "";
    }
    for (const key of ["profit", "loss", "liquidation", "exposure"]) {
      form.elements[key].value = config.alerts?.[key] ?? "";
    }
    $("editor-error").textContent = "";
    $("editor").showModal();
  }
  $("import").onclick = async () => {
    try {
      if (!owner) await list();
      const assets = [settings().assetA, settings().assetB];
      message("CHECKING LINKED POSITIONS AND FILL HISTORY…");
      const data = await readSnapshot(assets), state = pairAccountState(data);
      if (!state.accountFresh) {
        throw Error(
          "The linked account fill/funding sync is stale. Wait for account sync before importing.",
        );
      }
      const legs = assets.map((asset) => {
        const p = state.positions.find((row) => row.asset === asset),
          episode = replayPairLeg(state.fills, asset);
        if (!p || Number(p.signed_size) === 0) {
          throw Error(
            `No open linked position in ${asset}. Use a manual trade to monitor a planned position.`,
          );
        }
        if (!episode.complete) {
          throw Error(
            `${asset} has incomplete fill history; cannot import a verified cost basis.`,
          );
        }
        return {
          side: Number(p.signed_size) > 0 ? "long" : "short",
          quantity: String(p.signed_size).replace(/^-/, ""),
          entry: episode.entry,
          leverage: Number(p.leverage),
          marginMode: p.leverage_type,
          openedAt: episode.openedAt,
          episodeKey: episode.episodeKey,
        };
      });
      const config = normalizePair({
        source: "account",
        name: assets.join(" / "),
        assetA: assets[0],
        assetB: assets[1],
        legs,
        openedAt: Math.min(...legs.map((l) => l.openedAt)),
        costs: {},
        alerts: {},
      });
      const check = pairValuation(
        config,
        Object.fromEntries(assets.map((a) => [a, "1"])),
        { ...state, accountFresh: true },
      );
      if (check.legs.some((l) => !l.reconciled)) {
        throw Error(
          "Current positions do not reconcile with imported fills. Wait for the next account sync.",
        );
      }
      editor(config);
      message(
        "Review the imported trade, then save. Alerts remain off unless you enter thresholds.",
      );
    } catch (error) {
      message(error.message);
    }
  };
  $("manual").onclick = () => {
    const s = settings();
    editor({
      source: "manual",
      name: `${s.assetA} / ${s.assetB}`,
      assetA: s.assetA,
      assetB: s.assetB,
      openedAt: Date.now(),
      legs: [{
        side: "long",
        quantity: "",
        entry: "",
        leverage: 1,
        marginMode: "isolated",
      }, {
        side: "short",
        quantity: "",
        entry: "",
        leverage: 1,
        marginMode: "isolated",
      }],
      costs: {},
      alerts: {},
    });
  };
  $("edit").onclick = () => {
    if (selected) editor(selected.config, selected.id);
  };
  $("editor-cancel").onclick = () => $("editor").close();
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      if (!owner) await list();
      const input = structuredClone(editing.config);
      input.name = form.elements.name.value;
      if (input.source === "manual") {
        input.openedAt = Date.parse(form.elements.openedAt.value + "Z");
        input.legs = input.legs.map((leg, i) => ({
          ...leg,
          ...Object.fromEntries(
            ["side", "quantity", "entry", "leverage", "marginMode"].map(
              (key) => [key, form.elements[key + i].value],
            ),
          ),
        }));
        input.costs = Object.fromEntries(
          ["fees", "funding", "realized"].map(
            (key) => [key, form.elements[key].value],
          ),
        );
      }
      input.alerts = Object.fromEntries(
        ["profit", "loss", "liquidation", "exposure"].map(
          (key) => [key, form.elements[key].value],
        ),
      );
      const config = normalizePair(input);
      for (const [i, leg] of config.legs.entries()) {
        const asset = getCatalog().find((row) =>
          row.id === (i === 0 ? config.assetA : config.assetB)
        );
        if (asset?.maxLeverage && leg.leverage > asset.maxLeverage) {
          throw Error(`Leverage exceeds ${asset.maxLeverage}× for ${asset.id}`);
        }
      }
      if (config.openedAt > Date.now()) {
        throw Error("Trade entry must be at or before now.");
      }
      if (
        config.source === "manual" &&
        Object.keys(config.alerts).some((key) => key === "liquidation")
      ) {
        throw Error(
          "Liquidation alerts require imported Hyperliquid positions.",
        );
      }
      const row = {
        user_id: owner,
        config,
        updated_at: new Date().toISOString(),
      };
      const result = editing.id
        ? await client.from("pair_trades").update(row).eq("id", editing.id)
          .select().single()
        : await client.from("pair_trades").insert(row).select().single();
      if (result.error) throw result.error;
      savedId = result.data.id;
      $("editor").close();
      await list();
    } catch (error) {
      $("editor-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  $("select").onchange = () => choose($("select").value);
  $("archive").onclick = async () => {
    if (!selected) return;
    try {
      const r = await client.from("pair_trades").update({
        archived: true,
        updated_at: new Date().toISOString(),
      }).eq("id", selected.id);
      if (r.error) throw r.error;
      savedId = null;
      await list();
    } catch (error) {
      message(error.message);
    }
  };
  function disposeChart() {
    chart?.remove();
    chart = null;
    lines = [];
    $("pnl-chart").replaceChildren();
  }
  async function loadHistory(force = false) {
    if (
      !active || !selected || !account || historyBusy ||
      !$("pnl-details").open || !force && Date.now() - lastHistory < 60000
    ) return;
    historyBusy = true;
    const token = version, pair = selected.config, s = settings();
    $("pnl-status").textContent =
      "LOADING RECORDED MARKS AND ACTUAL POSITION HISTORY…";
    try {
      const start = Math.max(
        pair.openedAt,
        s.startTime ? s.startTime * 1000 : Date.now() - s.window * 1000,
      );
      const interval = Math.max(
        60,
        Math.ceil((Date.now() - start) / 1000 / 4800 / 60) * 60,
      );
      const result = await client.rpc("pair_mark_history", {
        p_assets: [pair.assetA, pair.assetB],
        p_start: new Date(start).toISOString(),
        p_end: new Date().toISOString(),
        p_interval: Math.min(86400, interval),
      });
      if (result.error) throw result.error;
      if (token !== version) return;
      historyRows = result.data.rows ?? [];
      const rows = pair.source === "account"
        ? accountPairCurve(pair, historyRows, account.fills, account.funding)
        : manualPairCurve(pair, historyRows);
      if (!rows.some((row) => row.value !== undefined)) {
        throw Error(
          "No verified mark-price P&L history in this range. Saved pairs retain observed marks from setup; older all-asset observations cover approximately eight days. Trade candles are not substituted for marks.",
        );
      }
      disposeChart();
      const lib = window.LightweightCharts;
      chart = lib.createChart($("pnl-chart"), {
        autoSize: true,
        height: 320,
        layout: {
          background: { type: "solid", color: "#101214" },
          textColor: "#a8afb7",
        },
        grid: {
          vertLines: { color: "#ffffff0a" },
          horzLines: { color: "#ffffff0a" },
        },
        timeScale: { timeVisible: true, minBarSpacing: 0.01 },
      });
      const metrics = pair.source === "account"
        ? [["valueA", "#20d6a5", pair.assetA], [
          "valueB",
          "#b799ff",
          pair.assetB,
        ], ["value", "#e7edf3", "NET PAIR"]]
        : [["value", "#e7edf3", "GROSS PAIR"]];
      for (const [key, color, title] of metrics) {
        const line = chart.addSeries(lib.LineSeries, {
          color,
          lineWidth: key === "value" ? 3 : 1,
          title,
          priceFormat: { type: "custom", minMove: 0.01, formatter: dollars },
        });
        line.setData(rows.map((row, i) => {
          const point = {
            time: Math.floor(row.time),
            ...(row[key] === undefined ? {} : { value: row[key] }),
          };
          if (
            rows[i + 1] &&
            ((row.slot != null && rows[i + 1].slot != null
              ? rows[i + 1].slot - row.slot > 1
              : rows[i + 1].time - row.time > interval * 1.5) ||
              rows[i + 1][key] === undefined)
          ) point.color = "transparent";
          return point;
        }));
        lines.push(line);
      }
      chart.timeScale().fitContent();
      lastChartTime = Math.floor(rows.at(-1).time);
      const first = rows.find((row) => row.value !== undefined),
        last = rows.findLast((row) => row.value !== undefined);
      $("pnl-status").textContent = `${
        pair.source === "account"
          ? "ACTUAL QUANTITIES, REALIZED P&L, FEES & FUNDING"
          : "GROSS PRICE P&L · MANUAL COST TIMING UNKNOWN"
      } · Recorded marks ${date(first.time * 1000)} → ${
        date(last.time * 1000)
      } · ${interval}s sampling. ${
        first.time * 1000 > start + interval * 1000
          ? "Earlier mark history unavailable. "
          : ""
      }Each leg uses its actual mark observation in the same time bucket. No synthetic history.`;
      $("pnl-chart").dataset.points = rows.filter((row) =>
        row.value !== undefined
      ).length;
      lastHistory = Date.now();
    } catch (error) {
      if (token === version) {
        disposeChart();
        $("pnl-status").textContent = error.message;
        lastHistory = Date.now();
      }
    } finally {
      historyBusy = false;
    }
  }
  $("pnl-details").addEventListener("toggle", () => {
    if ($("pnl-details").open) void loadHistory(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) closeStream();
    else if (active) {
      retryAt = 0;
      connect();
      void refresh();
    }
  });
  setInterval(() => {
    if (!active || document.hidden) return;
    if (socket && Date.now() - lastFrame > 60000) closeStream();
    connect();
    if (
      socket?.readyState === WebSocket.OPEN && Date.now() - lastPing > 20000
    ) {
      socket.send(JSON.stringify({ method: "ping" }));
      lastPing = Date.now();
    }
    if (Date.now() - lastRefresh > 10000) void refresh();
    render();
    if ($("pnl-details").open) void loadHistory();
  }, 1000);
  return {
    setActive(next) {
      active = next;
      if (next) {
        if (!owner) void list().catch((error) => message(error.message));
        else {
          void refresh();
          connect();
        }
      } else closeStream();
    },
    settingsChanged() {
      lastHistory = 0;
      if (active && $("pnl-details").open) void loadHistory(true);
    },
  };
}
