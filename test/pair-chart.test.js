import test from "node:test";
import assert from "node:assert/strict";
import {
  livePairObservation,
  pairChartModel,
  pairCurveEvaluator,
  pairHistoryRequest,
  pairViewPreferences,
  verifiedPairRows,
} from "../public/lib/pair-chart.js";
import { pairValuation } from "../public/lib/pair-trade.js";
const start = 1800000000000;
const pair = {
  source: "account",
  assetA: "A",
  assetB: "B",
  openedAt: start,
  name: "Pair",
  legs: [{
    side: "long",
    quantity: "10",
    entry: "100",
    leverage: 10,
    marginMode: "isolated",
    openedAt: start,
    episodeKey: "1",
  }, {
    side: "short",
    quantity: "5",
    entry: "200",
    leverage: 10,
    marginMode: "isolated",
    openedAt: start,
    episodeKey: "2",
  }],
  costs: {},
  alerts: {},
};
const fill = (asset, side, size, price, position, t, id, extra = {}) => ({
  asset,
  side,
  size: String(size),
  price: String(price),
  start_position: String(position),
  occurred_at_ms: start + t * 1000,
  trade_id: String(id),
  order_id: String(id),
  fee: "1",
  fee_token: "USDC",
  closed_pnl: "0",
  ...extra,
});
const fills = [
  fill("A", "buy", 10, 100, 0, 0, 1),
  fill("B", "sell", 5, 200, 0, 0, 2),
];
const row = (t, a = 110, b = 180) => ({
  time: start / 1000 + t,
  priceA: a,
  priceB: b,
  observedA: start / 1000 + t,
  observedB: start / 1000 + t,
});
const req = { start: start / 1000, end: start / 1000 + 600, interval: 15 };
test("view preferences preserve selected trade, sampling, custom dates and independent pair viewports", () => {
  const id = "00000000-0000-0000-0000-000000000123",
    p = pairViewPreferences({
      selectedPairId: id,
      selectionSet: true,
      assetA: "xyz:NVDA",
      assetB: "xyz:AMD",
      period: "custom",
      customStart: start / 1000,
      sampling: 15,
      follow: false,
      ranges: { [id]: { from: start / 1000, to: start / 1000 + 30 } },
    });
  assert.deepEqual(pairViewPreferences(JSON.parse(JSON.stringify(p))), p);
  assert.equal(
    pairViewPreferences({ period: "custom", customStart: NaN }).period,
    "trade",
  );
  assert.equal(
    pairViewPreferences({ assetA: "<script>", sampling: 12 }).sampling,
    0,
  );
});
test("history range is independent of the retired comparison baseline and trade cost basis", () => {
  const r = pairHistoryRequest(pair, {
    startTime: start / 1000 + 400,
    period: "trade",
  }, start + 600000);
  assert.equal(r.start, start / 1000);
  assert.equal(r.interval, 15);
  assert.equal(
    pairHistoryRequest(pair, {
      period: "custom",
      customStart: start / 1000 - 100,
    }, start + 600000).start,
    start / 1000,
  );
  assert.equal(
    pairHistoryRequest(pair, {
      period: "custom",
      customStart: start / 1000 + 100,
    }, start + 600000).start,
    start / 1000 + 100,
  );
});
test("long histories coarsen sampling enough to include the entire range without silent truncation", () => {
  const r = pairHistoryRequest(pair, { sampling: 15 }, start + 300 * 86400000);
  assert.ok((r.end - r.start) / r.interval <= 4800);
  assert.throws(
    () => pairHistoryRequest(pair, {}, start + 401 * 86400000),
    /400/,
  );
});
test("historical and live points share one quantity, realized P&L, fee and funding calculation", () => {
  const account = {
    fills: [
      ...fills,
      fill("A", "sell", 4, 120, 10, 10, 3, { closed_pnl: "80", fee: ".5" }),
    ],
    funding: [{
      asset: "B",
      occurred_at_ms: start + 20000,
      position_size: "-5",
      usdc: "3",
    }],
  };
  const evaluate = pairCurveEvaluator(pair, account),
    v = pairValuation(pair, { A: "110", B: "180" }, {
      ...account,
      positions: [{ asset: "A", signed_size: "6", entry_price: "100" }, {
        asset: "B",
        signed_size: "-5",
        entry_price: "200",
      }],
      accountFresh: true,
    });
  const model = pairChartModel(pair, [row(1)], [row(31)], evaluate, req);
  assert.equal(model.last.value, Number(v.net));
  assert.equal(model.last.valueA + model.last.valueB, model.last.value);
  assert.equal(model.first.value, 198);
});
test("history refresh cannot remove a newer observed live endpoint or reset its value", () => {
  const evaluate = pairCurveEvaluator(pair, { fills, funding: [] }),
    live = [row(34, 112, 180)];
  const a = pairChartModel(
      pair,
      [row(1), row(31, 110, 180)],
      live,
      evaluate,
      req,
    ),
    b = pairChartModel(pair, [row(1), row(32, 111, 180)], live, evaluate, req);
  assert.equal(a.last.time, b.last.time);
  assert.equal(a.last.value, 218);
  assert.equal(b.last.value, 218);
});
test("newly synced funding and partial fills recalculate existing live points at their actual event times", () => {
  const rows = [row(1), row(31)];
  const a = pairCurveEvaluator(pair, { fills, funding: [] })(rows),
    b = pairCurveEvaluator(pair, {
      fills,
      funding: [{
        asset: "A",
        position_size: "10",
        usdc: "-3",
        occurred_at_ms: start + 20000,
      }],
    })(rows);
  assert.equal(a[0].value, b[0].value);
  assert.equal(a[1].value - b[1].value, 3);
});
test("same-second updates and out-of-order rows yield strict unique timestamps", () => {
  const m = pairChartModel(
    pair,
    [row(31.1), row(1), row(31.2, 111, 180)],
    [row(31.9, 112, 180)],
    pairCurveEvaluator(pair, { fills, funding: [] }),
    req,
  );
  assert.deepEqual(m.rows.map((r) => r.time), [
    start / 1000 + 1,
    start / 1000 + 31,
  ]);
  assert.equal(m.last.value, 218);
});
test("missing, stale or future-dated leg marks remain whitespace, never forward filled", () => {
  const bad = { ...row(31), observedA: start / 1000 + 1 };
  const model = pairChartModel(
    pair,
    [row(1), bad, row(61)],
    [],
    pairCurveEvaluator(pair, { fills, funding: [] }),
    req,
  );
  assert.equal(model.rows[1].value, undefined);
  assert.equal(model.series[2].find(point=>point.value!==undefined).color, "transparent");
  assert.equal(model.missing, 1);
  assert.equal(
    verifiedPairRows([{ ...row(1), observedA: start / 1000 + 10 }], req)[0]
      .priceA,
    null,
  );
  assert.equal(verifiedPairRows([row(700)], req).length, 0);
});
test("multi-minute observation gaps do not draw a continuous line", () => {
  const m = pairChartModel(
    pair,
    [row(1), row(240)],
    [],
    pairCurveEvaluator(pair, { fills, funding: [] }),
    req,
  );
  assert.equal(m.series[2].find(point=>point.value!==undefined).color, "transparent");
});
test("stale accounting and stale quotes cannot advance the live endpoint", () => {
  const v = { fresh: true, net: "198" },
    quotes = {
      A: { price: "110", time: start + 30000 },
      B: { price: "180", time: start + 30000 },
    };
  assert.ok(livePairObservation(pair, v, quotes, start + 31000));
  assert.equal(
    livePairObservation(pair, { ...v, fresh: false }, quotes, start + 31000),
    null,
  );
  assert.equal(livePairObservation(pair, v, quotes, start + 46000), null);
  assert.equal(
    livePairObservation(pair, { ...v, net: null }, quotes, start + 31000),
    null,
  );
});
test("closed legs retain realized P&L when their market no longer supplies quotes", () => {
  const close = [
      ...fills,
      fill("A", "sell", 10, 120, 10, 10, 3, { closed_pnl: "200" }),
      fill("B", "buy", 5, 180, -5, 11, 4, { closed_pnl: "100" }),
    ],
    account = { fills: close, funding: [], positions: [], accountFresh: true };
  const v = pairValuation(pair, {}, account);
  assert.equal(v.net, "296");
  assert.equal(v.fresh, true);
  const observation = livePairObservation(pair, v, {}, start + 30000);
  assert.ok(observation);
  assert.equal(pairCurveEvaluator(pair, account)([observation])[0].value, 296);
});
test("missing target episode cannot produce a fabricated flat zero P&L line", () => {
  const p = {
    ...pair,
    legs: pair.legs.map((l) => ({ ...l, episodeKey: "missing" })),
  };
  const m = pairChartModel(
    p,
    [row(1), row(31)],
    [],
    pairCurveEvaluator(p, { fills, funding: [] }),
    req,
  );
  assert.equal(m.last, undefined);
  assert.equal(m.missing, 2);
});
test("manual gross P&L excludes untimed cost totals and preserves unavailable observations", () => {
  const p = {
    ...pair,
    source: "manual",
    costs: { fees: "999", funding: "999", realized: "999" },
  };
  const m = pairChartModel(
    p,
    [row(1), row(31, null, 180)],
    [],
    pairCurveEvaluator(p, { fills: [], funding: [] }),
    req,
  );
  assert.equal(m.first.value, 200);
  assert.equal(m.rows[1].value, undefined);
});

test('paused time windows retain history needed by their saved viewport as time advances',()=>{const id='00000000-0000-0000-0000-000000000123',from=start/1000+100,prefs={period:'1h',follow:false,ranges:{[id]:{from,to:from+600}}};const request=pairHistoryRequest(pair,prefs,start+7200000,id);assert.equal(request.start,from);assert.equal(request.end,start/1000+7200);});
test('requested start and end are whitespace anchors, never fabricated zero-return points',()=>{const m=pairChartModel(pair,[row(31)],[],pairCurveEvaluator(pair,{fills,funding:[]}),req);assert.deepEqual(m.series[2][0],{time:req.start});assert.deepEqual(m.series[2].at(-1),{time:req.end});assert.equal(m.rows.length,1);assert.notEqual(m.rows[0].value,0);});
