import DecimalBase from "../vendor/decimal.js";
const Decimal = DecimalBase.clone({
  precision: 40,
  rounding: DecimalBase.ROUND_HALF_UP,
});
const d = (value) => {
  const result = new Decimal(value);
  if (!result.isFinite()) throw Error("Invalid financial value");
  return result;
};
const text = (value) => value.toFixed();
const side = (value) => d(value).cmp(0);
const validAsset = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value);

export function normalizePair(input) {
  const result = {
    ...input,
    name: String(input.name ?? "Pair trade").trim().slice(0, 80),
    source: input.source === "account" ? "account" : "manual",
  };
  if (
    !validAsset(input.assetA) || !validAsset(input.assetB) ||
    input.assetA === input.assetB
  ) throw Error("Choose two different assets");
  result.legs = [0, 1].map((index) => {
    const leg = input.legs?.[index];
    if (!leg || !["long", "short"].includes(leg.side)) {
      throw Error("Set each leg's long/short direction");
    }
    if (!d(leg.quantity).gt(0) || !d(leg.entry).gt(0)) {
      throw Error("Quantity and entry price must be positive");
    }
    const leverage = Number(leg.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 100) {
      throw Error("Invalid leverage");
    }
    return {
      side: leg.side,
      quantity: text(d(leg.quantity)),
      entry: text(d(leg.entry)),
      leverage,
      marginMode: leg.marginMode === "cross" ? "cross" : "isolated",
      openedAt: leg.openedAt ?? null,
      episodeKey: leg.episodeKey ?? null,
    };
  });
  if (!Number.isFinite(input.openedAt) || input.openedAt <= 0) {
    throw Error("Set the trade's entry time");
  }
  result.costs = {};
  for (const key of ["fees", "funding", "realized"]) {
    result.costs[key] = input.costs?.[key] == null || input.costs[key] === ""
      ? null
      : text(d(input.costs[key]));
  }
  result.alerts = {};
  for (const key of ["profit", "loss", "liquidation", "exposure"]) {
    const value = input.alerts?.[key];
    if (value != null && value !== "") {
      if (!d(value).gt(0)) throw Error("Alert thresholds must be positive");
      result.alerts[key] = text(d(value));
    }
  }
  return result;
}

// Replay the CURRENT position episode, not all historical trades in an asset.
// Quantities, weighted entry, reversal fees and realized P&L use decimal math.
export function replayPairLeg(
  rows,
  asset,
  cutoff = Infinity,
  targetOpenedAt = null,
  onState = null,
) {
  const fills = rows.filter((fill) =>
    fill.asset === asset &&
    Number(fill.occurred_at_ms ?? Date.parse(fill.occurred_at)) <= cutoff
  ).sort((a, b) => {
    const time = Number(a.occurred_at_ms ?? Date.parse(a.occurred_at)) -
      Number(b.occurred_at_ms ?? Date.parse(b.occurred_at));
    if (time) return time;
    if (a.start_position != null && b.start_position != null) {
      const ae = d(a.start_position).plus(
          d(a.size).times(a.side === "buy" ? 1 : -1),
        ),
        be = d(b.start_position).plus(
          d(b.size).times(b.side === "buy" ? 1 : -1),
        );
      if (ae.eq(b.start_position) && !be.eq(a.start_position)) return -1;
      if (be.eq(a.start_position) && !ae.eq(b.start_position)) return 1;
      if (a.side === b.side) {
        return d(a.start_position).cmp(b.start_position) *
          (a.side === "buy" ? 1 : -1);
      }
    }
    return String(a.order_id).localeCompare(String(b.order_id), undefined, {
      numeric: true,
    });
  });
  let size = d(0),
    entry = d(0),
    realized = d(0),
    fees = d(0),
    openedAt = null,
    episodeKey = null,
    closedAt = null,
    direction = 0,
    complete = true,
    currencyKnown = true;
  const episodes = [];
  const matches = () =>
    targetOpenedAt == null || episodeKey === String(targetOpenedAt) ||
    openedAt === Number(targetOpenedAt);
  const snapshot = () => ({
    size: text(size),
    entry: text(entry),
    realized: text(realized),
    fees: text(fees),
    openedAt,
    episodeKey,
    closedAt,
    direction,
    complete: complete && currencyKnown,
    currencyKnown,
  });
  for (const fill of fills) {
    const start = fill.start_position == null ? size : d(fill.start_position),
      amount = d(fill.size),
      price = d(fill.price),
      delta = fill.side === "buy" ? amount : amount.neg(),
      end = start.plus(delta);
    if (!amount.gt(0) || !price.gt(0)) throw Error("Invalid fill");
    const opening = start.isZero() || side(start) === side(delta);
    if (start.isZero()) {
      if (openedAt !== null) episodes.push(snapshot());
      entry = d(0);
      realized = d(0);
      fees = d(0);
      complete = true;
      currencyKnown = true;
      openedAt = Number(fill.occurred_at_ms ?? Date.parse(fill.occurred_at));
      episodeKey = String(fill.trade_id ?? `${openedAt}:${fill.order_id}`);
      closedAt = null;
      direction = side(delta);
    } else if (!size.eq(start)) {
      complete = false;
      if (openedAt === null) {
        openedAt = Number(fill.occurred_at_ms ?? Date.parse(fill.occurred_at));
      }
    }
    const fee = d(fill.fee ?? 0),
      token = String(fill.fee_token ?? "").trim().toUpperCase();
    if (!["USDC", "USD"].includes(token)) currencyKnown = false;
    if (opening) {
      if (!start.isZero() && entry.isZero()) complete = false;
      entry = start.abs().times(entry).plus(amount.times(price)).div(end.abs());
      fees = fees.plus(fee);
    } else {
      const closing = Decimal.min(start.abs(), amount);
      if (!entry.gt(0)) complete = false;
      realized = realized.plus(
        fill.closed_pnl == null
          ? closing.times(price.minus(entry)).times(side(start))
          : d(fill.closed_pnl),
      );
      if (!end.isZero() && side(end) !== side(start)) {
        // The remaining size begins a new episode at the reversal's fill price.
        fees = fees.plus(fee.times(start.abs()).div(amount));
        size = d(0);
        closedAt = Number(fill.occurred_at_ms ?? Date.parse(fill.occurred_at));
        episodes.push(snapshot());
        if (onState && matches()) onState({ at: closedAt, ...snapshot() });
        openedAt = Number(fill.occurred_at_ms ?? Date.parse(fill.occurred_at));
        episodeKey = String(fill.trade_id ?? `${openedAt}:${fill.order_id}`) +
          ":open";
        entry = price;
        realized = d(0);
        fees = fee.times(end.abs()).div(amount);
        closedAt = null;
        direction = side(end);
        complete = true;
        currencyKnown = ["USDC", "USD"].includes(token);
      } else fees = fees.plus(fee);
    }
    size = end;
    if (end.isZero()) {
      closedAt = Number(fill.occurred_at_ms ?? Date.parse(fill.occurred_at));
    }
    if (onState && matches()) {
      onState({
        at: Number(fill.occurred_at_ms ?? Date.parse(fill.occurred_at)),
        ...snapshot(),
      });
    }
  }
  const latest = snapshot();
  if (targetOpenedAt != null) {
    return [...episodes, latest].findLast((episode) =>
      episode.episodeKey === String(targetOpenedAt) ||
      episode.openedAt === Number(targetOpenedAt)
    ) ??
      {
        size: "0",
        entry: "0",
        realized: "0",
        fees: "0",
        openedAt: Number(targetOpenedAt),
        closedAt: null,
        direction: 0,
        complete: cutoff < Number(targetOpenedAt),
        currencyKnown: true,
      };
  }
  return latest;
}

export function pairValuation(
  pairInput,
  marks,
  {
    positions = [],
    fills = [],
    funding = [],
    accountFresh = false,
    marksFresh = true,
  } = {},
) {
  const pair = normalizePair(pairInput);
  let long = d(0),
    short = d(0),
    gross = d(0),
    unrealized = d(0),
    realized = d(0),
    fees = d(0),
    cashFunding = d(0),
    complete = true;
  const legs = pair.legs.map((leg, index) => {
    const asset = index === 0 ? pair.assetA : pair.assetB;
    let position = pair.source === "account"
      ? positions.find((row) => row.asset === asset)
      : null;
    let qty = d(leg.quantity).times(leg.side === "long" ? 1 : -1),
      entry = d(leg.entry),
      reconciled = true,
      episode = null,
      legRealized = d(0),
      legFees = d(0),
      legFunding = d(0),
      legCostsKnown = true;
    if (pair.source === "account") {
      if (!accountFresh) complete = false;
      qty = d(position?.signed_size ?? 0);
      entry = d(position?.entry_price ?? leg.entry);
      episode = replayPairLeg(
        fills,
        asset,
        Infinity,
        leg.episodeKey ?? leg.openedAt,
      );
      if (episode.closedAt !== null) {
        qty = d(0);
        entry = d(episode.entry);
        position = null;
      }
      const quoteUnit = d(10).pow(entry.e - 5);
      reconciled = episode.complete && d(episode.size).eq(qty) &&
        (qty.isZero() ||
          d(episode.entry).minus(entry).abs().lte(
            Decimal.max(d("0.0000001"), quoteUnit),
          ));
      if (reconciled && !qty.isZero()) entry = d(episode.entry);
      complete &&= reconciled;
      if (reconciled) {
        legRealized = d(episode.realized);
        legFees = d(episode.fees);
        realized = realized.plus(legRealized);
        fees = fees.plus(legFees);
        for (
          const payment of funding.filter((row) =>
            row.asset === asset &&
            Number(row.occurred_at_ms ?? Date.parse(row.occurred_at)) >=
              episode.openedAt &&
            (episode.closedAt === null ||
              Number(row.occurred_at_ms ?? Date.parse(row.occurred_at)) <=
                episode.closedAt) &&
            side(row.position_size ?? episode.direction) === episode.direction
          )
        ) {
          if (payment.usdc == null) {
            complete = false;
            legCostsKnown = false;
          } else {
            cashFunding = cashFunding.plus(payment.usdc);
            legFunding = legFunding.plus(payment.usdc);
          }
        }
      }
    }
    const markInput = marks[asset],
      mark = markInput == null ? null : d(markInput);
    if (!mark?.gt(0)) complete = false;
    const notional = mark ? qty.abs().times(mark) : null;
    if (notional) {
      gross = gross.plus(notional);
      if (qty.gt(0)) long = long.plus(notional);
      else short = short.plus(notional);
    }
    const pnl = mark ? qty.times(mark.minus(entry)) : null;
    if (pnl) unrealized = unrealized.plus(pnl);
    const liq = qty.isZero() || position?.liquidation_price == null
      ? null
      : d(position.liquidation_price);
    const distance = liq?.gt(0) && mark?.gt(0) && !qty.isZero()
      ? mark.minus(liq).times(side(qty)).div(mark).times(100)
      : null;
    return {
      net:
        pair.source === "account" && reconciled && legCostsKnown && pnl !== null
          ? text(pnl.plus(legRealized).minus(legFees).plus(legFunding))
          : null,
      asset,
      side: qty.isZero() ? leg.side : qty.gt(0) ? "long" : "short",
      quantity: text(qty.abs()),
      entry: text(entry),
      mark: mark ? text(mark) : null,
      notional: notional ? text(notional) : null,
      unrealized: pnl ? text(pnl) : null,
      leverage: pair.source === "account"
        ? position?.leverage ??
          (episode?.closedAt != null ? leg.leverage : null)
        : leg.leverage,
      marginMode: pair.source === "account"
        ? position?.leverage_type ??
          (episode?.closedAt != null ? leg.marginMode : null)
        : leg.marginMode,
      margin: position?.margin_used ?? (episode?.closedAt != null ? "0" : null),
      liquidation: liq ? text(liq) : null,
      distance: distance ? text(distance) : null,
      reconciled,
      episode,
      observedAt: position?.observed_at ?? null,
    };
  });
  if (pair.source === "manual") {
    for (const key of ["fees", "funding", "realized"]) {
      if (pair.costs[key] === null) complete = false;
    }
    fees = d(pair.costs.fees ?? 0);
    cashFunding = d(pair.costs.funding ?? 0);
    realized = d(pair.costs.realized ?? 0);
  }
  const signed = long.minus(short),
    distances = legs.filter((leg) => leg.distance !== null).map((leg) =>
      d(leg.distance)
    );
  const priceKnown = legs.every((leg) => leg.mark !== null);
  return {
    legs,
    unrealized: priceKnown ? text(unrealized) : null,
    realized: text(realized),
    fees: text(fees),
    funding: text(cashFunding),
    costsComplete: complete,
    fresh: marksFresh && (pair.source === "manual" || accountFresh),
    net: complete && priceKnown
      ? text(unrealized.plus(realized).plus(cashFunding).minus(fees))
      : null,
    gross: priceKnown ? text(gross) : null,
    long: priceKnown ? text(long) : null,
    short: priceKnown ? text(short) : null,
    netExposure: priceKnown ? text(signed) : null,
    exposurePercent: priceKnown && gross.gt(0)
      ? text(signed.div(gross).times(100))
      : null,
    hedgeRatio: priceKnown && long.gt(0) ? text(short.div(long)) : null,
    liquidationBuffer:
      legs.every((leg) => d(leg.quantity).isZero() || leg.distance !== null) &&
        distances.length
        ? text(Decimal.min(...distances))
        : null,
  };
}

// Manual-position curve only: imported account curves replay position sizes at
// each timestamp in the caller; current size must never be projected backwards.
export function manualPairCurve(pairInput, rows) {
  const pair = normalizePair(pairInput);
  return rows.filter((row) =>
    row.time * 1000 >= pair.openedAt && row.priceA != null && row.priceB != null
  ).map((row) => ({
    time: row.time,
    slot: row.slot,
    value: Number(
      d(pair.legs[0].quantity).times(pair.legs[0].side === "long" ? 1 : -1)
        .times(d(row.priceA).minus(pair.legs[0].entry)).plus(
          d(pair.legs[1].quantity).times(pair.legs[1].side === "long" ? 1 : -1)
            .times(d(row.priceB).minus(pair.legs[1].entry)),
        ),
    ),
  }));
}

export function accountPairCurve(pairInput, rows, fills, funding) {
  const pair = normalizePair(pairInput);
  const states = [[], []],
    finals = pair.legs.map((leg, index) =>
      replayPairLeg(
        fills,
        index === 0 ? pair.assetA : pair.assetB,
        Infinity,
        leg.episodeKey ?? leg.openedAt,
        (state) => states[index].push(state),
      )
    );
  const payments = finals.map((episode, index) =>
    funding.filter((row) =>
      row.asset === (index === 0 ? pair.assetA : pair.assetB) &&
      Number(row.occurred_at_ms ?? Date.parse(row.occurred_at)) >=
        episode.openedAt &&
      (episode.closedAt === null ||
        Number(row.occurred_at_ms ?? Date.parse(row.occurred_at)) <=
          episode.closedAt) &&
      side(row.position_size ?? episode.direction) === episode.direction
    ).sort((a, b) =>
      Number(a.occurred_at_ms ?? Date.parse(a.occurred_at)) -
      Number(b.occurred_at_ms ?? Date.parse(b.occurred_at))
    )
  );
  const stateIndex = [0, 0],
    paymentIndex = [0, 0],
    cash = [d(0), d(0)],
    fundingKnown = [true, true];
  return rows.filter((row) => row.time * 1000 >= pair.openedAt).map((row) => {
    const values = [0, 1].map((index) => {
      const timeline = states[index],
        price = row[index === 0 ? "priceA" : "priceB"];
      while (
        stateIndex[index] + 1 < timeline.length &&
        timeline[stateIndex[index] + 1].at <= row.time * 1000
      ) stateIndex[index]++;
      while (
        paymentIndex[index] < payments[index].length &&
        Number(
            payments[index][paymentIndex[index]].occurred_at_ms ??
              Date.parse(payments[index][paymentIndex[index]].occurred_at),
          ) <= row.time * 1000
      ) {
        const payment = payments[index][paymentIndex[index]++];
        if (payment.usdc == null) fundingKnown[index] = false;
        else cash[index] = cash[index].plus(payment.usdc);
      }
      const state = timeline[stateIndex[index]];
      if (!state || state.at > row.time * 1000) return d(0);
      if (!state.complete || !fundingKnown[index] || price == null) return null;
      return d(state.size).times(d(price).minus(state.entry)).plus(
        state.realized,
      ).minus(state.fees).plus(cash[index]);
    });
    return {
      time: row.time,
      slot: row.slot,
      valueA: values[0] ? Number(values[0]) : undefined,
      valueB: values[1] ? Number(values[1]) : undefined,
      value: values.every((value) => value !== null)
        ? Number(values[0].plus(values[1]))
        : undefined,
    };
  });
}

// A fresh clearinghouse snapshot replaces its entire venue, including closures.
export function pairAccountState(snapshot, now = Date.now()) {
  const latest = new Map((snapshot.positions ?? []).map((p) => [p.asset, p]));
  const dexOf = (asset) => asset.includes(":") ? asset.split(":")[0] : "";
  const freshDexes = new Set();
  for (const row of snapshot.live ?? []) {
    if (now - Date.parse(row.observed_at) < 30000) {
      freshDexes.add(row.dex);
      for (const [asset] of latest) {
        if (dexOf(asset) === row.dex) latest.delete(asset);
      }
      for (const p of row.positions) latest.set(p.asset, p);
    }
  }
  const source = snapshot.source;
  return {
    positions: [...latest.values()],
    fills: snapshot.fills ?? [],
    funding: snapshot.funding ?? [],
    accountFresh: Boolean(
      source && !source.last_error &&
        now - Date.parse(source.last_success_at) < 120000,
    ),
    freshDexes,
  };
}
