import {
  livePairObservation,
  pairChartModel,
  pairCurveEvaluator,
  pairHistoryRequest,
} from "./lib/pair-chart.js?v=20261114-pair2";
const dollars = (v) =>
  Number.isFinite(v)
    ? new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(v)
    : "—";
const utc = (time) =>
  new Date(time * 1000).toISOString().replace("T", " ").replace(
    /\.\d+Z$/,
    " UTC",
  );
export function createPairPnlChart({ client, getSettings, updateSettings }) {
  const $ = (id) => document.getElementById("pair-" + id);
  let active = false,
    pair = null,
    id = null,
    account = null,
    valuation = null,
    quotes = {},
    history = [],
    live = new Map(),
    model = null,
    evaluate = null,
    ledgerKey = null,
    ledgerVersion = 0,
    lastVerifiedAt = null,
    fillsRef = null,
    fundingRef = null,
    lastQuoteKey = null,
    chart = null,
    lines = [],
    generation = 0,
    requestController = null,
    lastAttempt = 0,
    lastSuccess = 0,
    error = null,
    loading = false,
    paintTimer = null,
    rangeApplying = false,
    cursor = null,
    gestureUntil = 0,
    rangeCapture = null,
    loadedStart = null,
    rangeLoaded = false,
    accountingError = null;
  const showStatus = () => {
    if (!pair) return;
    const latest = model?.last;
    $("pnl-status").textContent = `${
      pair.source === "account"
        ? "NET P&L · ACTUAL FILLS, FEES & FUNDING"
        : "MANUAL SCENARIO · FIXED QUANTITIES · GROSS P&L"
    }${loading ? " · refreshing history" : ""}${
      error ? " · HISTORY REFRESH FAILED: " + error : ""
    }${lastSuccess ? " · history checked " + utc(lastSuccess / 1000) : ""}${
      (!valuation?.fresh || pair.source === "account" && valuation.net == null)
        ? " · LIVE UPDATE WITHHELD: STALE DATA OR INCOMPLETE ACCOUNTING"
        : ""
    }`;
    $("pnl-coverage").textContent = model?.first
      ? `Recorded observations (${model.interval}s samples): ${
        utc(model.first.time)
      } → ${utc(latest.time)}. ${
        model.first.time - model.requestedStart >
            Math.max(30, model.interval * 2)
          ? "First available observation is " +
            Math.round(model.first.time - model.requestedStart) +
            "s after the selected range start. "
          : ""
      }${
        model.missing
          ? model.missing +
            " observations have incomplete marks or accounting. "
          : ""
      }${
        model.gaps ? model.gaps + " gaps in recorded history. " : ""
      }The chart uses original trade cost basis; changing the visible range does not rebase P&L.`
      : "Waiting for verified observations. Missing prices and costs are never assumed to be zero.";
  };
  function readout() {
    const row = cursor == null
      ? model?.last
      : model?.rows.find((r) => r.time === cursor);
    $("pnl-readout").replaceChildren();
    const fields = pair?.source === "account"
      ? [[pair.assetA, "valueA"], [pair.assetB, "valueB"], [
        "NET PAIR",
        "value",
      ]]
      : [["GROSS PAIR", "value"]];
    for (const [name, key] of fields ?? []) {
      const cell = document.createElement("span");
      cell.textContent = `${name} ${dollars(row?.[key])}`;
      $("pnl-readout").append(cell);
    }
    $("pnl-time").textContent = row
      ? `${cursor == null ? "LATEST" : "SELECTED"} OBSERVATION · ${
        utc(row.time)
      }`
      : "No verified P&L observation";
  }
  function saveRange(range) {
    if (!id || !range) return;
    const s = getSettings();
    const ranges = { ...s.ranges };
    delete ranges[id];
    ranges[id] = range;
    updateSettings({ follow: false, ranges });
    $("pnl-follow").checked = false;
  }
  function makeChart() {
    if (chart || !active || !pair) return;
    const lib = window.LightweightCharts;
    if (!lib?.LineSeries) {
      throw Error("Chart library unavailable; reload to retry.");
    }
    chart = lib.createChart($("pnl-chart"), {
      autoSize: true,
      height: 520,
      layout: {
        background: { type: "solid", color: "#101214" },
        textColor: "#a8afb7",
      },
      grid: {
        vertLines: { color: "#ffffff0a" },
        horzLines: { color: "#ffffff0a" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: true,
        minBarSpacing: 0.01,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar: false,
      },
      crosshair: { mode: lib.CrosshairMode.Normal },
    });
    const fields = pair.source === "account"
      ? [[pair.assetA, "#20d6a5"], [pair.assetB, "#b799ff"], [
        "NET PAIR",
        "#e7edf3",
      ]]
      : [["GROSS PAIR", "#e7edf3"]];
    lines = fields.map(([title, color], i) =>
      chart.addSeries(lib.LineSeries, {
        title,
        color,
        lineWidth: i === fields.length - 1 ? 3 : 1,
        priceFormat: { type: "custom", minMove: 0.01, formatter: dollars },
        lastValueVisible: true,
        pointMarkersVisible: true,
        pointMarkersRadius: 1,
      })
    );
    lines.at(-1).createPriceLine({
      price: 0,
      color: "#69717b",
      lineStyle: 2,
      lineWidth: 1,
      axisLabelVisible: false,
    });
    const createdChart = chart;
    chart.subscribeCrosshairMove(({ time }) => {
      if (chart !== createdChart) return;
      cursor = typeof time === "number" ? time : null;
      readout();
    });
    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (chart !== createdChart) return;
      if (range) {
        $("pnl-chart").dataset.visibleFrom = String(range.from);
        $("pnl-chart").dataset.visibleTo = String(range.to);
      }
      if (
        rangeApplying || Date.now() > gestureUntil || !range ||
        typeof range.from !== "number" || typeof range.to !== "number"
      ) return;
      saveRange({ from: range.from, to: range.to });
    });
  }
  function paint() {
    paintTimer = null;
    if (!active || !pair || !account) return;
    try {
      const request = pairHistoryRequest(pair, getSettings(), Date.now(), id);
      const ready = valuation?.fresh &&
        (pair.source !== "account" || valuation.net != null);
      const verifiedEnd = ready ? request.end : Math.min(
        request.end,
        lastVerifiedAt ?? account.asOf ?? request.start,
      );
      model = pairChartModel(pair, history, [...live.values()], evaluate, {
        ...request,
        end: verifiedEnd,
      });
      if (!model.rows.length) {
        lines.forEach((line) => line.setData([]));
        $("pnl-chart").dataset.points = "0";
        $("pnl-chart").dataset.latest = "";
        showStatus();
        readout();
        return;
      }
      makeChart();
      const s = getSettings(),
        currentRange = chart.timeScale().getVisibleRange();
      rangeApplying = true;
      const savedViewport = s.ranges?.[id];
      const desired = s.follow
        ? { from: request.start, to: request.end }
        : !rangeLoaded && savedViewport
        ? savedViewport
        : currentRange ?? savedViewport;
      model.series.forEach((data, i) => {
        const points = new Map(data.map((point) => [point.time, point]));
        if (desired) {
          for (const boundary of [desired.from, desired.to]) {
            const time = Math.floor(boundary);
            if (!points.has(time)) points.set(time, { time });
          }
        }
        lines[i].setData([...points.values()].sort((a, b) => a.time - b.time));
      });
      const valid = model.rows.filter((row) => Number.isFinite(row.value));
      if (valid.length) {
        const saved = s.ranges?.[id];
        if (s.follow) {
          chart.timeScale().setVisibleRange({
            from: request.start,
            to: Math.max(request.start + 1, request.end),
          });
        } else if (!rangeLoaded && saved) {
          chart.timeScale().setVisibleRange(saved);
        } else if (currentRange) {
          chart.timeScale().setVisibleRange(currentRange);
        } else chart.timeScale().fitContent();
        rangeLoaded = true;
      }
      const range = chart.timeScale().getVisibleRange();
      Object.assign($("pnl-chart").dataset, {
        points: String(valid.length),
        latest: String(model.last?.value ?? ""),
        latestA: String(model.last?.valueA ?? ""),
        latestB: String(model.last?.valueB ?? ""),
        latestTime: String(model.last?.time ?? ""),
        latestAsOf: String(model.last?.asOf ?? ""),
        latestMarkA: String(model.last?.priceA ?? ""),
        latestMarkB: String(model.last?.priceB ?? ""),
        visibleFrom: String(range?.from ?? ""),
        visibleTo: String(range?.to ?? ""),
        sampling: String(request.interval),
      });
      const paintedChart = chart;
      requestAnimationFrame(() => {
        if (chart !== paintedChart) return;
        rangeApplying = false;
        const actual = chart?.timeScale().getVisibleRange();
        if (actual) {
          $("pnl-chart").dataset.visibleFrom = String(actual.from);
          $("pnl-chart").dataset.visibleTo = String(actual.to);
        }
      });
      showStatus();
      readout();
    } catch (e) {
      error = e.message;
      showStatus();
    }
  }
  function queuePaint() {
    if (!paintTimer) paintTimer = setTimeout(paint, 200);
  }
  async function loadHistory(force = false) {
    if (
      !active || !pair || !account || accountingError || loading ||
      !force && Date.now() - lastAttempt < 30000
    ) return;
    const token = generation, config = pair;
    let request;
    try {
      request = pairHistoryRequest(config, getSettings(), Date.now(), id);
    } catch (e) {
      error = e.message;
      lastAttempt = Date.now();
      showStatus();
      return;
    }
    lastAttempt = Date.now();
    loading = true;
    showStatus();
    const controller = new AbortController();
    requestController = controller;
    try {
      const result = await client.rpc("pair_mark_history", {
        p_assets: [config.assetA, config.assetB],
        p_start: new Date(request.start * 1000).toISOString(),
        p_end: new Date(request.end * 1000).toISOString(),
        p_interval: request.interval,
      }).abortSignal(controller.signal);
      if (token !== generation || controller.signal.aborted) return;
      if (result.error) throw Error(result.error.message);
      if (
        result.data?.basis !== "mark" ||
        result.data.interval !== request.interval ||
        !Array.isArray(result.data.rows)
      ) throw Error("Historical mark response could not be verified");
      history = result.data.rows;
      loadedStart = request.start;
      error = null;
      lastSuccess = Date.now();
      queuePaint();
    } catch (e) {
      if (token === generation && !controller.signal.aborted) {
        error = e.message;
        queuePaint();
      }
    } finally {
      if (token === generation) {
        loading = false;
        requestController = null;
        showStatus();
      }
    }
  }
  function resetRequest() {
    generation++;
    clearTimeout(rangeCapture);
    gestureUntil = 0;
    requestController?.abort();
    requestController = null;
    loading = false;
    lastAttempt = 0;
    rangeLoaded = false;
    history = [];
    error = null;
    queuePaint();
    void loadHistory(true);
  }
  function controls() {
    const s = getSettings();
    $("pnl-period").value = s.period;
    $("pnl-sampling").value = String(s.sampling);
    $("pnl-start-field").hidden = s.period !== "custom";
    $("pnl-start").value = s.customStart
      ? new Date(s.customStart * 1000).toISOString().slice(0, 19)
      : "";
    $("pnl-follow").checked = s.follow;
  }
  $("pnl-period").onchange = () => {
    const period = $("pnl-period").value;
    updateSettings({
      period,
      ...(period === "custom" && !getSettings().customStart
        ? { customStart: pair?.openedAt / 1000 }
        : {}),
      follow: true,
    });
    controls();
    resetRequest();
  };
  $("pnl-start").onchange = () => {
    const raw = $("pnl-start").value;
    const time = Date.parse(raw + "Z") / 1000;
    if (
      !Number.isFinite(time) ||
      new Date(time * 1000).toISOString().slice(0, raw.length) !== raw ||
      time >= Date.now() / 1000
    ) {
      $("pnl-status").textContent = "Choose a valid UTC start before now.";
      return;
    }
    updateSettings({ customStart: time, follow: true });
    resetRequest();
  };
  $("pnl-sampling").onchange = () => {
    updateSettings({ sampling: Number($("pnl-sampling").value) });
    resetRequest();
  };
  $("pnl-follow").onchange = () => {
    if (!$("pnl-follow").checked && chart) {
      const range = chart.timeScale().getVisibleRange();
      if (range) saveRange(range);
      else updateSettings({ follow: false });
    } else updateSettings({ follow: $("pnl-follow").checked });
    queuePaint();
  };
  $("pnl-reset").onclick = () => {
    const s = getSettings(), ranges = { ...s.ranges };
    delete ranges[id];
    updateSettings({ ranges, follow: true });
    rangeLoaded = false;
    lines.forEach((line) =>
      line.priceScale().applyOptions({ autoScale: true })
    );
    queuePaint();
  };
  $("pnl-retry").onclick = () => {
    void loadHistory(true);
  };
  function captureRange() {
    clearTimeout(rangeCapture);
    const current = chart;
    rangeCapture = setTimeout(() => {
      if (!active || chart !== current) return;
      const range = chart?.timeScale().getVisibleRange();
      if (range && !getSettings().follow) saveRange(range);
      if (Date.now() < gestureUntil) captureRange();
      else if (range && loadedStart != null && range.from < loadedStart - 1) {
        void loadHistory(true);
      }
    }, 50);
  }
  for (const event of ["pointerdown", "wheel", "touchstart"]) {
    $("pnl-chart").addEventListener(event, () => {
      gestureUntil = Date.now() + 1000;
      const range = chart?.timeScale().getVisibleRange();
      if (range) saveRange(range);
      else updateSettings({ follow: false });
      $("pnl-follow").checked = false;
      captureRange();
    }, { passive: true });
  }
  $("pnl-chart").addEventListener("pointermove", (event) => {
    if (event.buttons) {
      gestureUntil = Date.now() + 1000;
      captureRange();
    }
  }, { passive: true });
  setInterval(() => {
    if (!active || document.hidden) return;
    void loadHistory();
    showStatus();
  }, 1000);
  return {
    setActive(next) {
      active = next;
      if (next) {
        queuePaint();
        void loadHistory();
      } else {
        clearTimeout(rangeCapture);
        requestController?.abort();
        generation++;
        loading = false;
        clearTimeout(paintTimer);
        paintTimer = null;
      }
    },
    setPair(record) {
      generation++;
      clearTimeout(rangeCapture);
      gestureUntil = 0;
      loadedStart = null;
      requestController?.abort();
      loading = false;
      pair = record?.config ?? null;
      id = record?.id ?? null;
      account = null;
      evaluate = null;
      ledgerKey = null;
      fillsRef = null;
      fundingRef = null;
      lastQuoteKey = null;
      lastVerifiedAt = null;
      history = [];
      live = new Map();
      model = null;
      lastAttempt = 0;
      lastSuccess = 0;
      error = null;
      accountingError = null;
      rangeLoaded = false;
      rangeApplying = false;
      cursor = null;
      chart?.remove();
      chart = null;
      lines = [];
      controls();
      $("pnl-readout").replaceChildren();
      $("pnl-time").textContent = "";
      $("pnl-chart").replaceChildren();
      for (const key of Object.keys($("pnl-chart").dataset)) {
        delete $("pnl-chart").dataset[key];
      }
      if (pair) showStatus();
    },
    update(nextAccount, nextValue, nextQuotes) {
      if (!pair) return;
      accountingError = null;
      account = nextAccount;
      valuation = nextValue;
      quotes = nextQuotes;
      let changed = false;
      if (fillsRef !== account.fills || fundingRef !== account.funding) {
        fillsRef = account.fills;
        fundingRef = account.funding;
        const key = JSON.stringify([fillsRef, fundingRef]);
        changed = key !== ledgerKey;
        if (changed) {
          ledgerKey = key;
          ledgerVersion++;
          evaluate = pairCurveEvaluator(pair, account);
          lastAttempt = 0;
        }
      }
      const observation = livePairObservation(pair, valuation, quotes),
        qkey = JSON.stringify([
          quotes[pair.assetA],
          quotes[pair.assetB],
          ledgerVersion,
        ]);
      if (observation && qkey !== lastQuoteKey) {
        lastVerifiedAt = observation.time;
        lastQuoteKey = qkey;
        live.set(Math.floor(observation.time), observation);
        while (live.size > 10000) live.delete(live.keys().next().value);
      }
      queuePaint();
      if (changed || !lastAttempt) void loadHistory();
    },
    invalidate(reason) {
      accountingError = reason;
      valuation = null;
      error = "Accounting data unavailable: " + reason;
      showStatus();
    },
    settingsChanged() {
      controls();
    },
  };
}
