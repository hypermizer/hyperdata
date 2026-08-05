import { APP_CONFIG } from "./config.js?v=20260718-listener";
import { AssetPicker } from "./asset-picker.js?v=20260721-audio";
import { displayAssetSymbol } from "./lib/assets.js?v=20260720-stream";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260720-assets";
import { createWatchlistClient } from "./lib/supabase.js?v=20260728-persistent-auth";
import { accountSyncHealth, aggregateEpisodeOrders, buildPositionEpisodes, fetchAllAccountFills, formatTradeTimestamp, normalizeAccountFill } from "./lib/account-trades.js?v=20260805-order-rows";
import { buildTradeLedger, normalizeTradeOrder } from "./lib/trade-log.js?v=20260804-trade-log";

const client = createWatchlistClient(APP_CONFIG);
const TAG_OPTIONS = ["EARNINGS", "MEANREV", "YOLO"];
const elements = {
  executedAt: document.querySelector("#trade-log-executed-at"),
  form: document.querySelector("#trade-log-form"),
  message: document.querySelector("#trade-log-message"),
  accountAddress: document.querySelector("#trade-account-address"),
  accountFillCount: document.querySelector("#trade-account-fill-count"),
  accountFills: document.querySelector("#trade-account-fills"),
  accountHealth: document.querySelector("#trade-account-health"),
  accountPositions: document.querySelector("#trade-account-positions"),
  status: document.querySelector("#trade-log-status"),
  table: document.querySelector("#trade-log-table"),
};
elements.controls = [...elements.form.querySelectorAll("input, button")];
const picker = new AssetPicker(document.querySelector("#trade-log-asset-picker"), { details: "none" });
const state = {
  accountError: null, accountLoaded: false, accountSource: null, catalogState: "loading",
  expandedPositions: new Set(), fills: [], orders: [], pending: false, positions: [],
  positionTags: new Map(), tagEditorPositionKey: "", tagPending: new Set(), tagVersion: 0, user: null,
};

wire();
initialize().catch((error) => showError(error));

function wire() {
  elements.form.addEventListener("submit", addOrder);
  elements.table.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-trade-order]");
    if (button) deleteOrder(button.dataset.deleteTradeOrder);
  });
  elements.accountFills.addEventListener("click", (event) => {
    const tag = event.target.closest("[data-position-tag]");
    if (tag) {
      togglePositionTag(tag.dataset.positionKey, tag.dataset.positionTag).catch((error) => showError(error));
      return;
    }
    const editor = event.target.closest("[data-position-tag-editor]");
    if (editor) {
      state.tagEditorPositionKey = state.tagEditorPositionKey === editor.dataset.positionTagEditor ? "" : editor.dataset.positionTagEditor;
      renderAccountData();
      return;
    }
    const row = event.target.closest("[data-position-toggle]");
    if (row) togglePosition(row.dataset.positionToggle);
  });
  elements.accountFills.addEventListener("keydown", (event) => {
    if (event.target.closest("button, a, input, select, textarea")) return;
    const row = event.target.closest("[data-position-toggle]");
    if (!row || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    togglePosition(row.dataset.positionToggle);
  });
  window.addEventListener("focus", () => {
    if (state.user && !state.pending && !state.tagPending.size) loadTradeData().catch((error) => showError(error));
  });
  window.setInterval(() => {
    if (state.user && !state.pending && !state.tagPending.size && !document.hidden) loadAccountData().catch((error) => showError(error));
  }, 15_000);
}

async function initialize() {
  setDefaultExecutionTime();
  render();
  const catalogPromise = getMarketCatalog()
    .then((catalog) => {
      picker.setCatalog(catalog);
      state.catalogState = "ready";
      render();
    })
    .catch(() => {
      state.catalogState = "error";
      render();
      setMessage("ASSET LIST UNAVAILABLE · RELOAD TO RETRY", "warning");
    });
  const sessionResponse = await (client?.auth.getSession() ?? Promise.resolve({ data: { session: null }, error: null }));
  if (sessionResponse.error) throw sessionResponse.error;
  client?.auth.onAuthStateChange((_event, session) => window.setTimeout(() => {
    setSession(session).catch((error) => showError(error));
  }, 0));
  await setSession(sessionResponse.data.session);
  await catalogPromise;
}

async function setSession(session) {
  state.user = session?.user?.email === APP_CONFIG.allowedEmail ? session.user : null;
  state.accountError = null;
  state.accountLoaded = false;
  state.accountSource = null;
  state.fills = [];
  state.orders = [];
  state.positions = [];
  state.positionTags = new Map();
  state.tagEditorPositionKey = "";
  state.expandedPositions = new Set();
  state.tagPending = new Set();
  state.tagVersion += 1;
  if (state.user) await loadTradeData();
  else render();
}

async function loadTradeData() {
  await Promise.all([loadOrders(false), loadAccountData(false)]);
  render();
}

async function loadOrders(renderAfter = true) {
  const { data, error } = await client
    .from("trade_log_orders")
    .select("id,asset,side,shares,price,executed_at,note,created_at")
    .order("executed_at", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  state.orders = data ?? [];
  if (renderAfter) render();
}

async function loadAccountData(renderAfter = true) {
  const previousSuccess = state.accountSource?.last_success_at ?? null;
  const snapshotVersion = state.tagVersion;
  const [sourceResult, tagsResult] = await Promise.all([
    client.from("hyperliquid_account_sources").select("address,last_success_at,last_error").maybeSingle(),
    client.from("hyperliquid_account_position_tags").select("position_key,tags"),
  ]);
  if (sourceResult.error) {
    state.accountError = sourceResult.error.message;
    state.accountSource = null;
    if (renderAfter) render();
    return;
  }
  state.accountSource = sourceResult.data;
  const tagError = snapshotVersion === state.tagVersion ? tagsResult.error : null;
  state.accountError = tagError?.message ?? null;
  if (!tagsResult.error && snapshotVersion === state.tagVersion) {
    state.positionTags = new Map((tagsResult.data ?? []).map((row) => [row.position_key, row.tags ?? []]));
  }
  if (state.accountLoaded && sourceResult.data?.last_success_at === previousSuccess) {
    if (renderAfter) render();
    return;
  }
  const [fillsResult, positionsResult] = await Promise.all([
    fetchAllAccountFills((from, to) => client.from("hyperliquid_account_fills")
      .select("trade_id,asset,side,direction,size,price,start_position,closed_pnl,fee,fee_token,occurred_at,order_id,transaction_hash")
      .order("occurred_at", { ascending: false })
      .order("trade_id", { ascending: false })
      .range(from, to)),
    client.from("hyperliquid_account_positions")
      .select("dex,asset,signed_size,entry_price,position_value,unrealized_pnl,margin_used,liquidation_price,leverage_type,leverage,observed_at")
      .order("asset", { ascending: true }),
  ]);
  const error = tagError ?? fillsResult.error ?? positionsResult.error;
  state.accountError = error?.message ?? null;
  state.fills = fillsResult.error ? [] : (fillsResult.data ?? []).map(normalizeAccountFill);
  state.positions = positionsResult.error ? [] : positionsResult.data ?? [];
  state.accountLoaded = !error;
  if (renderAfter) render();
}

function togglePosition(positionKey) {
  if (state.expandedPositions.has(positionKey)) state.expandedPositions.delete(positionKey);
  else state.expandedPositions.add(positionKey);
  renderAccountData();
}

async function togglePositionTag(positionKey, tag) {
  if (!state.user || !state.accountSource?.address || !TAG_OPTIONS.includes(tag) || state.tagPending.has(positionKey)) return;
  const episode = buildPositionEpisodes(state.fills).find((candidate) => candidate.positionKey === positionKey);
  if (!episode) return;
  const previous = [...(state.positionTags.get(positionKey) ?? [])];
  const next = previous.includes(tag) ? previous.filter((value) => value !== tag) : [...previous, tag];
  state.tagVersion += 1;
  state.positionTags.set(positionKey, next);
  state.tagPending.add(positionKey);
  renderAccountData();
  try {
    let result;
    if (next.length) {
      result = await client.from("hyperliquid_account_position_tags").upsert({
        user_id: state.user.id,
        account_address: state.accountSource.address,
        position_key: positionKey,
        asset: episode.asset,
        direction: episode.direction,
        tags: next,
      }, { onConflict: "user_id,account_address,position_key" });
    } else {
      result = await client.from("hyperliquid_account_position_tags").delete()
        .eq("user_id", state.user.id)
        .eq("account_address", state.accountSource.address)
        .eq("position_key", positionKey);
    }
    if (result.error) throw result.error;
    setMessage(`${episode.label} TAGS UPDATED`, "success");
  } catch (error) {
    state.positionTags.set(positionKey, previous);
    throw error;
  } finally {
    state.tagPending.delete(positionKey);
    renderAccountData();
  }
}

async function addOrder(event) {
  event.preventDefault();
  if (!state.user || state.pending) return;
  try {
    const form = new FormData(elements.form);
    const order = normalizeTradeOrder({
      asset: picker.value,
      side: form.get("side"),
      shares: form.get("shares"),
      price: form.get("price"),
      executedAt: form.get("executedAt"),
      note: form.get("note"),
    });
    buildTradeLedger([...state.orders, {
      id: "pending",
      asset: order.asset,
      side: order.side,
      shares: order.shares,
      price: order.price,
      executed_at: order.executedAt,
      created_at: new Date().toISOString(),
    }]);
    setPending(true);
    const { error } = await client.from("trade_log_orders").insert({
      user_id: state.user.id,
      asset: order.asset,
      side: order.side,
      shares: order.shares,
      price: order.price,
      executed_at: order.executedAt,
      note: order.note,
    });
    if (error) throw error;
    elements.form.reset();
    picker.clear();
    setDefaultExecutionTime();
    await loadOrders();
    setMessage("ORDER ADDED", "success");
  } catch (error) {
    showError(error);
  } finally {
    setPending(false);
  }
}

async function deleteOrder(id) {
  if (!state.user || state.pending) return;
  try {
    buildTradeLedger(state.orders.filter((order) => order.id !== id));
    setPending(true);
    const { error } = await client
      .from("trade_log_orders")
      .delete()
      .eq("id", id)
      .eq("user_id", state.user.id);
    if (error) throw error;
    await loadOrders();
    setMessage("ORDER REMOVED", "success");
  } catch (error) {
    showError(error);
  } finally {
    setPending(false);
  }
}

function render() {
  let ledger;
  try {
    ledger = buildTradeLedger(state.orders);
  } catch (error) {
    elements.status.textContent = "DATA ERROR";
    elements.table.innerHTML = `<p class="message">${escapeHtml(error.message)}</p>`;
    elements.controls.forEach((control) => { control.disabled = true; });
    picker.setDisabled(true);
    renderAccountData();
    return;
  }
  const enabled = Boolean(state.user) && state.catalogState === "ready" && !state.pending;
  elements.controls.forEach((control) => { control.disabled = !enabled; });
  picker.setDisabled(!enabled);
  renderAccountData();
  if (!state.user) {
    elements.status.textContent = client ? "SIGN IN TO LOAD" : "STORAGE UNAVAILABLE";
    elements.table.innerHTML = `<p class="hint">SIGN IN TO LOAD ORDERS.</p>`;
    return;
  }
  const catalogStatus = state.catalogState === "error" ? " · ASSET LIST ERROR" : "";
  elements.status.textContent = `${countSubmittedOrders(state.fills)} EXCHANGE ORDERS · ${state.positions.length} LIVE POSITIONS · ${ledger.length} MANUAL ORDERS${catalogStatus}`;
  elements.table.innerHTML = ledger.length ? renderTable([...ledger].reverse()) : `<p class="hint">NO ORDERS YET.</p>`;
}

function renderAccountData() {
  if (!state.user) {
    elements.accountHealth.textContent = client ? "SIGN IN TO LOAD" : "STORAGE UNAVAILABLE";
    elements.accountFills.innerHTML = `<p class="hint">SIGN IN TO LOAD FILLS.</p>`;
    elements.accountPositions.innerHTML = `<p class="hint">SIGN IN TO LOAD POSITIONS.</p>`;
    return;
  }
  const health = state.accountError
    ? { label: `SYNC DATA ERROR · ${state.accountError.toUpperCase()}`, tone: "error" }
    : accountSyncHealth(state.accountSource);
  elements.accountHealth.textContent = health.label;
  elements.accountHealth.dataset.tone = health.tone;
  elements.accountAddress.textContent = state.accountSource?.address ?? "ACCOUNT SOURCE NOT CONFIGURED";
  const episodes = buildPositionEpisodes(state.fills);
  elements.accountFillCount.textContent = `${episodes.length} POSITIONS · ${countSubmittedOrders(state.fills)} ORDERS`;
  elements.accountFills.innerHTML = episodes.length ? renderFillTable(episodes) : `<p class="hint">NO FILLS INGESTED YET.</p>`;
  elements.accountPositions.innerHTML = state.positions.length ? renderPositionTable(state.positions) : `<p class="hint">NO OPEN POSITIONS.</p>`;
}

function countSubmittedOrders(fills) {
  return new Set(fills.map((fill) => `${fill.asset}|${fill.orderId}`)).size;
}

function renderFillTable(episodes) {
  const rows = episodes.map((episode) => {
    const expanded = state.expandedPositions.has(episode.positionKey);
    const orders = aggregateEpisodeOrders(episode);
    const orderRows = orders.map((order, index) => `<tr class="trade-position-fill"${expanded ? "" : " hidden"}>
      <td><span class="trade-order-label"><strong>ORDER ${index + 1}</strong>${order.fillCount > 1 ? `<small>${order.fillCount} FILLS COMBINED</small>` : ""}</span></td>
      <td>${escapeHtml(formatDate(order.occurredAt))}</td>
      <td class="trade-side ${order.side}">${escapeHtml(order.direction.toUpperCase())}</td>
      <td>${formatQuantity(order.size)}${Math.abs(order.episodeSize - order.size) > 1e-12 ? `<small class="trade-order-allocation">${formatQuantity(order.episodeSize)} IN POSITION</small>` : ""}</td>
      <td>${formatPrice(order.price)}</td><td>${formatMoney(order.value)}</td>
      <td>${formatMoney(order.closedPnl)}</td><td>${formatMoney(order.fee)}</td><td></td>
    </tr>`).join("");
    const editorOpen = state.tagEditorPositionKey === episode.positionKey;
    const tagEditor = editorOpen ? `<tr class="trade-position-tag-editor-row"><td colspan="9">${renderPositionTagEditor(episode)}</td></tr>` : "";
    return `<tr class="trade-position-root ${episode.direction}" data-position-toggle="${escapeHtml(episode.positionKey)}" tabindex="0" role="button" aria-expanded="${expanded}">
      <td><strong class="trade-position-name">${escapeHtml(episode.label)}</strong></td>
      <td>${escapeHtml(formatDate(episode.openedAt))}</td>
      <td>${orders.length} ${orders.length === 1 ? "ORDER" : "ORDERS"} · ${episode.status.toUpperCase()}${episode.partialHistory ? " · EARLIER ENTRY" : ""}</td>
      <td>${formatQuantity(episode.currentSize)}</td><td>—</td><td>—</td>
      <td>${formatMoney(episode.closedPnl)}</td><td>${formatMoney(episode.fees)}</td>
      <td>${renderPositionTags(episode)}</td>
    </tr>${tagEditor}${orderRows}`;
  }).join("");
  return `<table class="paper-table trade-position-table"><thead><tr><th>POSITION / ORDER</th><th>TIME</th><th>ACTIVITY</th><th>SHARES</th><th>AVG PRICE</th><th>NOTIONAL</th><th>REALIZED PNL</th><th>FEES</th><th>TAGS</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPositionTags(episode) {
  const selected = state.positionTags.get(episode.positionKey) ?? [];
  const disabled = state.tagPending.has(episode.positionKey);
  return `<div class="trade-position-tags">${selected.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}<button type="button" data-position-tag-editor="${escapeHtml(episode.positionKey)}" aria-expanded="${state.tagEditorPositionKey === episode.positionKey}"${disabled ? " disabled" : ""}>TAG</button></div>`;
}

function renderPositionTagEditor(episode) {
  const selected = state.positionTags.get(episode.positionKey) ?? [];
  const disabled = state.tagPending.has(episode.positionKey);
  return `<div class="trade-position-tag-editor"><strong>TAG ${escapeHtml(episode.label)}</strong>${TAG_OPTIONS.map((tag) => `<button type="button" data-position-key="${escapeHtml(episode.positionKey)}" data-position-tag="${tag}" aria-pressed="${selected.includes(tag)}"${disabled ? " disabled" : ""}>${tag}</button>`).join("")}</div>`;
}

function renderPositionTable(positions) {
  const rows = positions.map((position) => `<tr><td>${escapeHtml(displayAssetSymbol({ id: position.asset }))}</td><td>${formatQuantity(position.signed_size)}</td><td>${formatPrice(position.entry_price)}</td><td>${formatMoney(position.position_value)}</td><td>${formatMoney(position.unrealized_pnl)}</td><td>${formatMoney(position.margin_used)}</td><td>${position.liquidation_price == null ? "—" : formatPrice(position.liquidation_price)}</td><td>${escapeHtml(`${position.leverage ?? "—"}X ${position.leverage_type ?? ""}`.trim().toUpperCase())}</td><td>${escapeHtml(formatDate(position.observed_at))}</td></tr>`).join("");
  return `<table class="paper-table"><thead><tr><th>ASSET</th><th>SIZE</th><th>ENTRY</th><th>VALUE</th><th>UNREALIZED PNL</th><th>MARGIN</th><th>LIQUIDATION</th><th>LEVERAGE</th><th>OBSERVED</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderTable(ledger) {
  const rows = ledger.map((row) => `<tr>
    <td>${escapeHtml(formatDate(row.executed_at))}</td>
    <td>${escapeHtml(displayAssetSymbol({ id: row.asset }))}</td>
    <td class="trade-side ${row.side}">${row.side.toUpperCase()}</td>
    <td>${formatQuantity(row.shares)}</td>
    <td>${formatPrice(row.price)}</td>
    <td>${formatMoney(row.orderValue)}</td>
    <td>#${row.positionNumber}</td>
    <td>${formatQuantity(row.sharesAfter)}</td>
    <td>${row.status.toUpperCase()}</td>
    <td class="trade-log-note">${escapeHtml(row.note || "—")}</td>
    <td><button type="button" data-delete-trade-order="${escapeHtml(row.id)}" aria-label="Remove order" title="Remove order">×</button></td>
  </tr>`).join("");
  return `<table class="paper-table"><thead><tr><th>EXECUTED</th><th>ASSET</th><th>SIDE</th><th>SHARES</th><th>PRICE</th><th>VALUE</th><th>POSITION</th><th>HELD AFTER</th><th>STATUS</th><th>NOTE</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function setPending(pending) {
  state.pending = pending;
  render();
}

function setDefaultExecutionTime() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  elements.executedAt.value = local.toISOString().slice(0, 16);
}

function setMessage(message, tone = "") {
  elements.message.textContent = message;
  if (tone) elements.message.dataset.tone = tone;
  else delete elements.message.dataset.tone;
}

function showError(error) {
  setMessage(error instanceof Error ? error.message : "TRADE LOG UNAVAILABLE");
}

function formatDate(value) {
  return formatTradeTimestamp(value);
}

function formatQuantity(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function formatPrice(value) {
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}`;
}

function formatMoney(value) {
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}
