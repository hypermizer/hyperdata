import test from "node:test";
import assert from "node:assert/strict";
import {
  accountPairCurve,
  manualPairCurve,
  normalizePair,
  pairAccountState,
  pairValuation,
  replayPairLeg,
} from "../public/lib/pair-trade.js";
const start = 1800000000000;
const pair = (source = "manual") => ({
  name: "Test pair",
  source,
  assetA: "A",
  assetB: "B",
  openedAt: start,
  legs: [{
    side: "long",
    quantity: "10",
    entry: "100",
    leverage: 20,
    marginMode: "isolated",
    openedAt: start,
    episodeKey: "1",
  }, {
    side: "short",
    quantity: "5",
    entry: "200",
    leverage: 10,
    marginMode: "cross",
    openedAt: start,
    episodeKey: "2",
  }],
  costs: { fees: "2", funding: "-3", realized: "4" },
  alerts: {},
});
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
  ...extra,
});
const opening = [
  fill("A", "buy", 10, 100, 0, 0, 1),
  fill("B", "sell", 5, 200, 0, 0, 2),
];
const positions = [{
  asset: "A",
  signed_size: "10",
  entry_price: "100",
  liquidation_price: "90",
  leverage: 20,
  leverage_type: "isolated",
}, {
  asset: "B",
  signed_size: "-5",
  entry_price: "200",
  liquidation_price: "240",
  leverage: 10,
  leverage_type: "cross",
}];
const value = (fills = opening, options = {}) =>
  pairValuation(pair("account"), { A: "110", B: "180" }, {
    positions,
    fills,
    accountFresh: true,
    marksFresh: true,
    ...options,
  });

test("signed quantity P&L, exposure, and costs are independent of leverage", () => {
  const p = pair(), v = pairValuation(p, { A: "110", B: "180" });
  assert.equal(v.unrealized, "200");
  assert.equal(v.net, "199");
  assert.equal(v.long, "1100");
  assert.equal(v.short, "900");
  assert.equal(v.netExposure, "200");
  assert.equal(v.exposurePercent, "10");
  p.legs[0].leverage = 1;
  assert.equal(pairValuation(p, { A: "110", B: "180" }).net, "199");
});
test("unknown costs withhold net rather than assume zero; unrelated account risk cannot leak into manual trade", () => {
  const p = pair();
  p.costs.funding = null;
  const v = pairValuation(p, { A: "110", B: "180" }, { positions });
  assert.equal(v.net, null);
  assert.equal(v.unrealized, "200");
  assert.equal(v.liquidationBuffer, null);
});
test("account valuation reconciles both fills and charges fees once", () => {
  const v = value(opening, {
    funding: [{
      asset: "A",
      occurred_at_ms: start + 1000,
      position_size: "10",
      usdc: "-2",
    }, {
      asset: "B",
      occurred_at_ms: start + 1000,
      position_size: "-5",
      usdc: "3",
    }],
  });
  assert.equal(v.net, "199");
  assert.equal(v.fees, "2");
  assert.equal(v.funding, "1");
  assert.equal(v.legs[0].distance, "18.18181818181818181818181818181818181818");
});
test("partial close preserves weighted entry and adds realized P&L without applying current quantity backwards", () => {
  const fills = [
      ...opening,
      fill("A", "sell", 4, 120, 10, 10, 3, { closed_pnl: "80", fee: ".5" }),
    ],
    pos = [{ ...positions[0], signed_size: "6" }, positions[1]];
  const v = value(fills, { positions: pos });
  assert.equal(v.unrealized, "160");
  assert.equal(v.realized, "80");
  assert.equal(v.fees, "2.5");
  assert.equal(v.net, "237.5");
  const curve = accountPairCurve(
    pair("account"),
    [{ time: start / 1000 + 1, priceA: 110, priceB: 180 }, {
      time: start / 1000 + 11,
      priceA: 110,
      priceB: 180,
    }],
    fills,
    [],
  );
  assert.equal(curve[0].value, 198);
  assert.equal(curve[1].value, 237.5);
});
test("completed original episode cannot silently become a later reopened position", () => {
  const fills = [
    ...opening,
    fill("A", "sell", 10, 120, 10, 10, 3, { closed_pnl: "200" }),
    fill("A", "buy", 50, 130, 0, 20, 4),
  ];
  const v = value(fills, {
    positions: [
      { ...positions[0], signed_size: "50", entry_price: "130" },
      positions[1],
    ],
  });
  assert.equal(v.legs[0].quantity, "0");
  assert.equal(v.realized, "200");
  assert.equal(v.net, "297");
});
test("reversal splits fees proportionally and saves a distinct episode identity", () => {
  const fills = [
    fill("A", "buy", 10, 100, 0, 0, 1),
    fill("A", "sell", 15, 120, 10, 10, 3, { closed_pnl: "200", fee: "3" }),
  ];
  const old = replayPairLeg(fills, "A", Infinity, "1"),
    current = replayPairLeg(fills, "A");
  assert.equal(old.size, "0");
  assert.equal(old.fees, "3");
  assert.equal(old.realized, "200");
  assert.equal(current.size, "-5");
  assert.equal(current.entry, "120");
  assert.equal(current.fees, "1");
  assert.equal(current.episodeKey, "3:open");
});
test("unreconciled, missing, or non-USDC fee history cannot produce a claimed net total", () => {
  assert.equal(value(opening.slice(1)).net, null);
  assert.equal(value(opening.slice(1)).fresh, false);
  assert.equal(
    value([{ ...opening[0], start_position: "5" }, opening[1]]).net,
    null,
  );
  assert.equal(
    value([{ ...opening[0], fee_token: "HYPE" }, opening[1]]).net,
    null,
  );
  assert.equal(value(opening, { accountFresh: false }).fresh, false);
  assert.equal(value(opening, { accountFresh: false }).net, null);
});
test("weighted fill precision survives Hyperliquid six significant digit entry rounding", () => {
  const fills = [fill("A", "buy", 10, "161.1183592", 0, 0, 1), opening[1]],
    v = value(fills, {
      positions: [{ ...positions[0], entry_price: "161.118" }, positions[1]],
    });
  assert.equal(v.legs[0].reconciled, true);
  assert.equal(v.legs[0].entry, "161.1183592");
});
test("decimal fill averaging avoids floating point balance errors and handles identical timestamps", () => {
  const a = fill("A", "buy", ".1", "1.1", 0, 0, 1),
    b = fill("A", "buy", ".2", "1.2", ".1", 0, 2);
  const state = replayPairLeg([b, a], "A");
  assert.equal(state.size, "0.3");
  assert.equal(state.complete, true);
  assert.equal(state.entry, "1.166666666666666666666666666666666666667");
});
test("funding in another position episode or opposite direction cannot enter saved trade P&L", () => {
  const payments = [{
    asset: "A",
    occurred_at_ms: start - 1,
    position_size: "10",
    usdc: "999",
  }, {
    asset: "A",
    occurred_at_ms: start + 1,
    position_size: "-10",
    usdc: "999",
  }, {
    asset: "A",
    occurred_at_ms: start + 1,
    position_size: "10",
    usdc: "-1",
  }];
  assert.equal(value(opening, { funding: payments }).funding, "-1");
});
test("unknown funding remains unknown on every later historical point", () => {
  const rows = [1, 2, 3].map((t) => ({
      time: start / 1000 + t,
      priceA: 110,
      priceB: 180,
    })
    ),
    payments = [{
      asset: "A",
      occurred_at_ms: start + 1000,
      position_size: "10",
      usdc: null,
    }];
  assert.ok(
    accountPairCurve(pair("account"), rows, opening, payments).every((row) =>
      row.value === undefined
    ),
  );
});
test("history uses actual entry dates, fees at fills, and zero before the second leg opens", () => {
  const fills = [opening[0], { ...opening[1], occurred_at_ms: start + 2000 }];
  const rows = [1, 3].map((t) => ({
    time: start / 1000 + t,
    priceA: 110,
    priceB: 180,
  }));
  const p = pair("account");
  p.legs[1].openedAt = start + 2000;
  const values = accountPairCurve(p, rows, fills, []);
  assert.equal(values[0].value, 99);
  assert.equal(values[1].value, 198);
  assert.equal(
    manualPairCurve(pair(), [{
      time: start / 1000 - 1,
      priceA: 110,
      priceB: 180,
    }, ...rows]).length,
    2,
  );
});
test("fresh whole-venue snapshots remove closed positions; stale snapshots cannot hide current canonical positions", () => {
  const source = { last_success_at: new Date(start).toISOString() };
  const snapshot = {
    source,
    positions,
    live: [{
      dex: "",
      positions: [],
      observed_at: new Date(start).toISOString(),
    }],
  };
  assert.deepEqual(pairAccountState(snapshot, start + 1).positions, []);
  assert.equal(pairAccountState(snapshot, start + 31000).positions.length, 2);
  assert.equal(pairAccountState(snapshot, start + 121000).accountFresh, false);
});
test("normalization rejects invalid trades, directions, financial amounts and alert thresholds", () => {
  for (
    const bad of [
      { assetB: "A" },
      { openedAt: NaN },
      { legs: [{ ...pair().legs[0], quantity: "0" }, pair().legs[1]] },
      { alerts: { profit: "-1" } },
      { costs: { fees: "Infinity" } },
    ]
  ) assert.throws(() => normalizePair({ ...pair(), ...bad }));
});

test("missing marks cannot masquerade as zero notional or complete liquidation risk", () => {
  const v = pairValuation(pair("account"), { A: "110" }, {
    positions,
    fills: opening,
    accountFresh: true,
  });
  assert.equal(v.netExposure, null);
  assert.equal(v.long, null);
  assert.equal(v.short, null);
  assert.equal(v.gross, null);
  assert.equal(v.liquidationBuffer, null);
  const missing = value(opening, {
    positions: [positions[0], { ...positions[1], liquidation_price: null }],
  });
  assert.equal(missing.liquidationBuffer, null);
});

test("same-millisecond fills follow position chain even when input and order IDs run backwards", () => {
  const a = fill("A", "buy", 1, 100, 0, 0, 300),
    b = fill("A", "buy", 2, 110, 1, 0, 200),
    c = fill("A", "sell", 1, 120, 3, 0, 100, {
      closed_pnl: "13.3333333333333333333333333333333333333",
    });
  const state = replayPairLeg([c, b, a], "A");
  assert.equal(state.complete, true);
  assert.equal(state.size, "2");
  assert.ok(Math.abs(Number(state.entry) - 106.6666666667) < 1e-9);
});
test("ambiguous same-timestamp position loops fail closed rather than guess episode accounting", () => {
  const rows = [
    fill("A", "buy", 10, 100, 0, 0, 1),
    fill("A", "sell", 10, 120, 10, 0, 2, { closed_pnl: "200" }),
    fill("A", "buy", 10, 130, 0, 0, 3),
  ];
  assert.equal(replayPairLeg(rows, "A").complete, false);
});
test("duplicate fills are idempotent and contradictory copies are rejected", () => {
  assert.equal(replayPairLeg([opening[0], opening[0]], "A").size, "10");
  assert.throws(
    () => replayPairLeg([opening[0], { ...opening[0], price: "101" }], "A"),
    /Conflicting/,
  );
});
test("a missing closing fill cannot silently leave a verified original episode open", () => {
  const state = replayPairLeg(
    [opening[0], fill("A", "buy", 10, 100, 0, 20, 3)],
    "A",
    Infinity,
    "1",
  );
  assert.equal(state.complete, false);
});
test("missing fees remain unknown; close P&L is derived from execution cash flows", () => {
  assert.equal(
    replayPairLeg([{ ...opening[0], fee: null }], "A").complete,
    false,
  );
  assert.equal(
    replayPairLeg([opening[0], fill("A", "sell", 10, 120, 10, 10, 3)], "A")
      .realized,
    "200",
  );
});

test("rounded reported closed P&L cannot contaminate fill cash-flow accounting", () => {
  const rows = [
    fill("A", "buy", 10, "100.1234567", 0, 0, 1),
    fill("A", "sell", 3, 110, 10, 10, 3, { closed_pnl: "29.631" }),
  ];
  const state = replayPairLeg(rows, "A");
  assert.equal(state.realized, "29.6296299");
  const p = pair("account"),
    v = pairValuation(p, { A: "110", B: "180" }, {
      positions: [
        { asset: "A", signed_size: "7", entry_price: "100.123" },
        positions[1],
      ],
      fills: [...rows, opening[1]],
      funding: [],
      accountFresh: true,
    });
  assert.equal(v.net, "195.765433");
});

test("account monitors require a fixed position episode identity", () => {
  const p = pair("account");
  p.legs[0].episodeKey = null;
  assert.throws(() => normalizePair(p), /trade identity/);
});
test("funding at an indistinguishable same-millisecond close/reopen is not double attributed", () => {
  const fills = [
      ...opening,
      fill("A", "sell", 10, 120, 10, 10, 3),
      fill("A", "buy", 10, 130, 0, 10, 4),
    ],
    payments = [{
      asset: "A",
      occurred_at_ms: start + 10000,
      position_size: "10",
      usdc: "-2",
    }];
  const v = value(fills, {
    positions: [{ ...positions[0], entry_price: "130" }, positions[1]],
    funding: payments,
  });
  assert.equal(v.net, null);
});
