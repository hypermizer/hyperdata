import { APP_CONFIG } from "./config.js?v=20260720-paper";
import { AssetPicker } from "./asset-picker.js?v=20260721-audio";
import { applyLiveMarketContext, postInfo } from "./lib/hyperliquid.js?v=20260722-order-ticket";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260722-order-ticket";
import {
  activePaperEpoch,
  estimateIsolatedLiquidationPrice,
  estimateMarketFill,
  formatPaperNumber,
  normalizeAccountName,
  normalizePaperFeeSchedule,
  normalizePaperOrder,
  normalizeStartingCapital,
  paperFeeRates,
  paperOrderPreview,
  paperSignClass,
} from "./lib/paper.js?v=20260722-order-ticket";
import { createWatchlistClient } from "./lib/supabase.js?v=20260720-paper";

const client = createWatchlistClient(APP_CONFIG);
const state = {
  user: null, accounts: [], epochs: [], account: null, epoch: null, pending: false,
  feeSchedule: null, feeRates: { maker: 0.00015, taker: 0.00045 },
  quoteStream: null, quotedAsset: "", quoteUpdatedAt: 0, bookUpdatedAt: 0, book: null,
};
const $ = (selector) => document.querySelector(selector);
const elements = {
  account: $("#paper-account"), newAccount: $("#paper-new-account"), reset: $("#paper-reset-account"),
  archive: $("#paper-archive-account"), status: $("#paper-status"), metrics: $("#paper-metrics"),
  form: $("#paper-order-form"), message: $("#paper-message"), positions: $("#paper-positions"),
  orders: $("#paper-orders"), history: $("#paper-history"),
  accountDialog: $("#paper-account-dialog"), accountForm: $("#paper-account-form"),
  accountMessage: $("#paper-account-message"), accountName: $("#paper-account-name"),
  startingCapital: $("#paper-starting-capital"),
  leverage: $("#paper-leverage"), leverageLabel: $("#paper-leverage-label"),
  leverageSlider: $("#paper-leverage-slider"), limitFields: $("#paper-limit-fields"),
  limitPrice: $("#paper-limit-price"), size: $("#paper-size"), sizeUnit: $("#paper-size-unit"),
  sizeSlider: $("#paper-size-slider"), livePrice: $("#paper-live-price"),
  liveStatus: $("#paper-live-status"), availableMargin: $("#paper-available-margin"),
  currentPosition: $("#paper-current-position"), orderPrice: $("#paper-order-price"),
  orderValue: $("#paper-order-value"), marginRequired: $("#paper-margin-required"),
  estimatedFee: $("#paper-estimated-fee"), feeRates: $("#paper-fee-rates"),
  maxSize: $("#paper-max-size"), slippage: $("#paper-slippage"),
  liquidationPrice: $("#paper-liquidation-price"), quoteAge: $("#paper-quote-age"),
  estimatedCost: $("#paper-estimated-cost"),
  placeOrder: $("#paper-place-order"), validation: $("#paper-order-validation"),
  orderPanel: $("#paper-order-panel"),
};
const paperAssetPicker = new AssetPicker($("#paper-asset-picker"));

wire();
initialize();

function wire() {
  elements.account.addEventListener("change", () => selectAccount(elements.account.value));
  elements.newAccount.addEventListener("click", openAccountDialog);
  elements.accountForm.addEventListener("submit", createAccount);
  document.querySelectorAll("[data-close-paper-account]").forEach((button) => button.addEventListener("click", () => elements.accountDialog.close()));
  elements.reset.addEventListener("click", resetAccount);
  elements.archive.addEventListener("click", archiveAccount);
  elements.form.addEventListener("submit", placeOrder);
  elements.orders.addEventListener("click", cancelOrder);
  elements.form.addEventListener("input", handleOrderInput);
  elements.form.addEventListener("change", handleOrderInput);
  elements.form.addEventListener("click", handleSizeShortcut);
  paperAssetPicker.root.addEventListener("assetchange", handleAssetChange);
  setInterval(() => { if (!document.hidden && state.user && state.account) loadAccountState(); }, 5_000);
}

async function initialize() {
  if (!client) return renderStatus("STORAGE UNAVAILABLE");
  const [catalog, { data }, feePayload] = await Promise.all([
    getMarketCatalog(),
    client.auth.getSession(),
    postInfo({ type: "userFees", user: "0x0000000000000000000000000000000000000000" }).catch(() => null),
  ]);
  try {
    state.feeSchedule = feePayload ? normalizePaperFeeSchedule(feePayload) : null;
  } catch {
    state.feeSchedule = null;
  }
  paperAssetPicker.setCatalog(catalog);
  const initialAsset = catalog.find(({ id }) => id === APP_CONFIG.initialWatchlist[0]) ?? catalog[0];
  if (initialAsset) paperAssetPicker.select(initialAsset.id);
  connectQuoteStream();
  await setSession(data.session);
  client.auth.onAuthStateChange((_event, session) => setTimeout(() => setSession(session), 0));
  window.setInterval(() => {
    if (!document.hidden && !elements.orderPanel.hidden) updateOrderPreview();
  }, 1_000);
}

async function setSession(session) {
  state.user = session?.user?.email === APP_CONFIG.allowedEmail ? session.user : null;
  if (!state.user) {
    state.accounts = []; state.account = null; state.epoch = null;
    render(); return;
  }
  await loadAccounts();
}

async function loadAccounts(preferredId = state.account?.id) {
  const [accountsResponse, epochsResponse] = await Promise.all([
    client.from("paper_accounts").select("*").is("archived_at", null).not("name", "like", "__SHADOW__%").order("created_at"),
    client.from("paper_account_epochs").select("*").eq("state", "active"),
  ]);
  if (accountsResponse.error || epochsResponse.error) return fail(accountsResponse.error ?? epochsResponse.error);
  state.accounts = accountsResponse.data ?? [];
  state.epochs = epochsResponse.data ?? [];
  const selected = state.accounts.find((account) => account.id === preferredId) ?? state.accounts[0] ?? null;
  state.account = selected;
  state.epoch = activePaperEpoch(selected, state.epochs);
  renderAccountOptions();
  if (selected) await loadAccountState(); else render();
}

async function selectAccount(id) {
  state.account = state.accounts.find((account) => account.id === id) ?? null;
  state.epoch = activePaperEpoch(state.account, state.epochs);
  await loadAccountState();
}

async function loadAccountState() {
  if (!state.epoch) return render();
  const epochId = state.epoch.id;
  const [epoch, summary, positions, orders, ledger] = await Promise.all([
    client.from("paper_account_epochs").select("version,epoch_number,state").eq("id", epochId).single(),
    client.from("paper_account_summaries").select("*").eq("epoch_id", epochId).single(),
    client.from("paper_positions").select("*").eq("epoch_id", epochId).order("asset"),
    client.from("paper_orders").select("*").eq("epoch_id", epochId).in("status", ["resting", "partially_filled", "trigger_waiting"]).order("created_at", { ascending: false }),
    client.from("paper_ledger_entries").select("*").eq("epoch_id", epochId).order("created_at", { ascending: false }).limit(100),
  ]);
  const error = epoch.error ?? summary.error ?? positions.error ?? orders.error ?? ledger.error;
  if (error) return fail(error);
  state.epoch = { ...state.epoch, ...epoch.data, summary: summary.data, positions: positions.data ?? [], orders: orders.data ?? [], ledger: ledger.data ?? [] };
  render();
}

function openAccountDialog() {
  elements.accountMessage.textContent = "";
  elements.accountName.value = `PAPER ${state.accounts.length + 1}`;
  elements.startingCapital.value = "5000";
  if (!elements.accountDialog.open) elements.accountDialog.showModal();
  elements.accountName.select();
}

async function createAccount(event) {
  event.preventDefault();
  try {
    setPending(true);
    const name = normalizeAccountName(elements.accountName.value);
    const startingCapital = normalizeStartingCapital(elements.startingCapital.value);
    const { data, error } = await client.rpc("create_paper_account", { p_name: name, p_starting_capital: startingCapital });
    if (error) throw error;
    elements.accountDialog.close();
    await loadAccounts(data);
  } catch (error) { elements.accountMessage.textContent = String(error?.message ?? error).toUpperCase(); } finally { setPending(false); }
}

async function resetAccount() {
  if (!state.account || !window.confirm(`Reset ${state.account.name} to ${money(state.account.starting_capital)}?`)) return;
  await runAccountRpc("reset_paper_account", { p_account_id: state.account.id }, state.account.id);
}

async function archiveAccount() {
  if (!state.account || !window.confirm(`Archive ${state.account.name}?`)) return;
  await runAccountRpc("archive_paper_account", { p_account_id: state.account.id });
}

async function runAccountRpc(name, args, preferredId) {
  try {
    setPending(true); const { error } = await client.rpc(name, args); if (error) throw error;
    await loadAccounts(preferredId);
  } catch (error) {
    fail(error);
    if (state.account) await loadAccounts(state.account.id);
  } finally { setPending(false); }
}

async function placeOrder(event) {
  event.preventDefault(); elements.message.textContent = "";
  try {
    if (!APP_CONFIG.paperTradingEnabled) throw new Error("PAPER TRADING IS IN SHADOW MODE.");
    if (!state.account || !state.epoch) throw new Error("Create an account first.");
    const formData = new FormData(elements.form);
    const form = Object.fromEntries(formData);
    form.asset = paperAssetPicker.value;
    form.reduceOnly = formData.has("reduceOnly");
    const market = selectedMarket();
    const order = normalizePaperOrder(form, market?.maxLeverage ?? Infinity);
    setPending(true);
    const { data, error } = await client.functions.invoke("paper-command", { body: {
      type: "place_order", accountId: state.account.id, epochNumber: state.epoch.epoch_number,
      expectedVersion: Number(state.epoch.version), idempotencyKey: crypto.randomUUID(), order,
    } });
    if (error) throw error;
    elements.message.textContent = String(data?.response?.status ?? "ORDER ACCEPTED").toUpperCase();
    elements.size.value = "";
    elements.sizeSlider.value = "0";
    updateLeverageLimit(true);
    await loadAccounts(state.account.id);
  } catch (error) {
    fail(error);
    if (state.account) await loadAccounts(state.account.id);
  } finally { setPending(false); }
}

async function cancelOrder(event) {
  const button = event.target.closest("button[data-order-id]");
  if (!button || !state.account || !APP_CONFIG.paperTradingEnabled) return;
  await runAccountRpc("cancel_paper_order", { p_account_id: state.account.id, p_order_id: button.dataset.orderId }, state.account.id);
}

function updateOrderFields() {
  const type = selectedOrderType();
  const locked = !state.user || !state.account || !APP_CONFIG.paperTradingEnabled || state.pending;
  const isLimit = type === "limit";
  elements.limitFields.hidden = !isLimit;
  elements.form.elements.limitPrice.disabled = locked || !isLimit;
  elements.form.elements.timeInForce.disabled = locked || !isLimit;
  if (isLimit && !(Number(elements.limitPrice.value) > 0) && Number(selectedMarket()?.markPrice) > 0) {
    elements.limitPrice.value = String(selectedMarket().markPrice);
  }
  updateOrderPreview();
}

function selectedMarket() {
  return paperAssetPicker.selectedAsset;
}

function handleAssetChange() {
  updateLeverageLimit(true);
  subscribeQuote(selectedMarket()?.id ?? "");
  const symbol = selectedMarket()?.symbol ?? "SHARES";
  elements.sizeUnit.textContent = symbol;
  updateOrderPreview();
}

function updateLeverageLimit(resetToMaximum = false) {
  const maxLeverage = selectedMarket()?.maxLeverage;
  if (Number.isFinite(maxLeverage)) {
    elements.leverage.max = String(maxLeverage);
    elements.leverageSlider.max = String(maxLeverage);
    if (resetToMaximum) {
      elements.leverage.value = String(maxLeverage);
      elements.leverageSlider.value = String(maxLeverage);
    }
  } else {
    elements.leverage.removeAttribute("max");
    elements.leverageSlider.max = "1";
  }
  elements.leverageLabel.textContent = Number.isFinite(maxLeverage) ? `MAX ${maxLeverage}×` : "—";
  clampLeverage();
}

function clampLeverage() {
  const maxLeverage = Number(elements.leverage.max);
  const leverage = Math.max(1, Math.min(maxLeverage || Infinity, Math.round(Number(elements.leverage.value) || 1)));
  elements.leverage.value = String(leverage);
  elements.leverageSlider.value = String(leverage);
}

function selectedOrderType() {
  return elements.form.elements.orderType.value;
}

function selectedSide() {
  return elements.form.elements.side.value;
}

function handleOrderInput(event) {
  if (event.type === "input" && event.target === elements.leverage) clampLeverage();
  if (event.type === "input" && event.target === elements.leverageSlider) {
    elements.leverage.value = elements.leverageSlider.value;
  }
  if (event.type === "input" && event.target === elements.sizeSlider) {
    setSizeFromPercent(Number(elements.sizeSlider.value));
    return;
  }
  if (event.target.name === "orderType") {
    updateOrderFields();
    return;
  }
  updateOrderPreview();
}

function handleSizeShortcut(event) {
  const button = event.target.closest("button[data-size-percent]");
  if (!button) return;
  const percent = Number(button.dataset.sizePercent);
  elements.sizeSlider.value = String(percent);
  setSizeFromPercent(percent);
}

function setSizeFromPercent(percent) {
  const preview = previewOrder();
  if (!(preview.maxSize >= 0)) return;
  const decimals = Math.max(0, Math.min(8, Number(selectedMarket()?.sizeDecimals) || 0));
  const scale = 10 ** decimals;
  const size = Math.floor(preview.maxSize * Math.max(0, Math.min(100, percent)) / 100 * scale) / scale;
  elements.size.value = size > 0 ? String(size) : "";
  updateOrderPreview();
}

function previewOrder() {
  const market = selectedMarket();
  const summary = state.epoch?.summary;
  const currentPosition = Number(state.epoch?.positions?.find(({ asset }) => asset === market?.id)?.signed_size) || 0;
  const reservedMargin = (state.epoch?.orders ?? []).reduce((total, order) => total + Number(order.reserved_margin || 0), 0);
  const availableMargin = Math.max(0, Number(summary?.equity || 0) - Number(summary?.margin_used || 0) - reservedMargin);
  const orderType = selectedOrderType();
  const side = selectedSide();
  const hasFreshBook = state.bookUpdatedAt > 0 && Date.now() - state.bookUpdatedAt <= 5_000;
  const marketFill = orderType === "market"
    ? estimateMarketFill(hasFreshBook && side === "buy" ? state.book?.levels?.[1]
      : hasFreshBook ? state.book?.levels?.[0] : [], elements.size.value, market?.markPrice, side)
    : null;
  const feeRate = orderType === "limit" && elements.form.elements.timeInForce.value === "ALO"
    ? state.feeRates.maker
    : state.feeRates.taker;
  const preview = paperOrderPreview({
    size: elements.size.value,
    markPrice: market?.markPrice,
    executionPrice: marketFill?.averagePrice,
    limitPrice: elements.limitPrice.value,
    orderType,
    leverage: elements.leverage.value,
    feeRate,
    availableMargin,
    marginTiers: market?.marginTiers,
    currentPosition,
    reduceOnly: elements.form.elements.reduceOnly.checked,
    side,
  });
  const marginMode = elements.form.elements.marginMode.value;
  const nextTier = market?.marginTiers?.[1];
  const simpleIsolatedEstimate = marginMode === "isolated" && currentPosition === 0
    && (!nextTier || preview.orderValue < Number(nextTier.lowerBound));
  return {
    ...preview,
    marketFill,
    liquidationPrice: simpleIsolatedEstimate
      ? estimateIsolatedLiquidationPrice(preview.price, side, elements.leverage.value, market?.maxLeverage)
      : null,
  };
}

function updateOrderPreview() {
  const market = selectedMarket();
  const preview = previewOrder();
  const side = selectedSide();
  const orderType = selectedOrderType();
  const quoteAge = state.quoteUpdatedAt ? Date.now() - state.quoteUpdatedAt : null;
  const size = Number(elements.size.value);
  const enabled = Boolean(state.user && state.account && APP_CONFIG.paperTradingEnabled && !state.pending);
  const hasAmount = Number.isFinite(size) && size > 0;
  const hasPrice = Number.isFinite(preview.price) && preview.price > 0;
  const hasFreshQuote = quoteAge !== null && quoteAge <= 5_000;
  const hasExecutionPreview = orderType === "limit" || Boolean(preview.marketFill);
  const withinCapacity = preview.maxSize === null || size <= preview.maxSize + Number.EPSILON;
  const valid = enabled && Boolean(market) && hasAmount && hasPrice && hasFreshQuote && hasExecutionPreview && withinCapacity;

  elements.livePrice.textContent = money(market?.markPrice);
  elements.liveStatus.textContent = quoteStatus(market, quoteAge);
  elements.availableMargin.textContent = market ? money(preview.availableMargin) : "—";
  elements.currentPosition.textContent = market ? `${formatPaperNumber(preview.currentPosition, market.sizeDecimals ?? 4)} ${market.symbol}` : "—";
  elements.orderPrice.textContent = money(preview.price);
  elements.orderValue.textContent = money(preview.orderValue);
  elements.marginRequired.textContent = money(preview.marginRequired);
  elements.estimatedFee.textContent = money(preview.estimatedFee, 4);
  elements.estimatedCost.textContent = money(preview.estimatedCost, 4);
  elements.feeRates.textContent = `${percentRate(state.feeRates.maker)} / ${percentRate(state.feeRates.taker)}`;
  elements.maxSize.textContent = market && preview.maxSize !== null ? `${formatPaperNumber(preview.maxSize, market.sizeDecimals ?? 4)} ${market.symbol}` : "—";
  elements.slippage.textContent = orderType === "limit" ? "N/A"
    : preview.marketFill ? `${preview.marketFill.slippagePercent >= 0 ? "+" : ""}${preview.marketFill.slippagePercent.toFixed(4)}%${preview.marketFill.complete ? "" : " PARTIAL"}` : "AWAITING BOOK";
  elements.liquidationPrice.textContent = elements.form.elements.marginMode.value === "cross"
    ? "PORTFOLIO"
    : preview.liquidationPrice === null ? "POSITION / TIER" : money(preview.liquidationPrice);
  elements.quoteAge.textContent = quoteAge === null ? "SNAPSHOT" : `${Math.max(0, quoteAge / 1_000).toFixed(1)}S`;
  elements.placeOrder.textContent = `PLACE ${side === "buy" ? "LONG" : "SHORT"}`;
  elements.placeOrder.dataset.side = side;
  elements.placeOrder.disabled = !valid;

  if (!state.user) elements.validation.textContent = "SIGN IN TO PLACE PAPER ORDERS";
  else if (!state.account) elements.validation.textContent = "CREATE A PAPER ACCOUNT FIRST";
  else if (!market) elements.validation.textContent = "SELECT AN ASSET";
  else if (!hasAmount) elements.validation.textContent = `ENTER AN AMOUNT GREATER THAN 0 ${market.symbol}`;
  else if (!hasFreshQuote) elements.validation.textContent = "WAITING FOR A LIVE HYPERLIQUID MARK";
  else if (!hasExecutionPreview) elements.validation.textContent = "WAITING FOR THE LIVE ORDER BOOK";
  else if (orderType === "limit" && !hasPrice) elements.validation.textContent = "ENTER A LIMIT PRICE GREATER THAN 0";
  else if (!withinCapacity) elements.validation.textContent = elements.form.elements.reduceOnly.checked
    ? "AMOUNT EXCEEDS THE POSITION AVAILABLE TO REDUCE"
    : "ESTIMATED COST EXCEEDS AVAILABLE MARGIN";
  else elements.validation.textContent = `${formatPaperNumber(size, market.sizeDecimals ?? 4)} ${market.symbol} · ${orderType.toUpperCase()} · ${elements.leverage.value}×`;

  if (document.activeElement !== elements.sizeSlider && preview.maxSize > 0 && hasAmount) {
    elements.sizeSlider.value = String(Math.max(0, Math.min(100, Math.round(size / preview.maxSize * 100))));
  }
}

function quoteStatus(market, quoteAge) {
  if (!market) return "SELECT AN ASSET";
  if (quoteAge === null) return "WAITING FOR LIVE HYPERLIQUID MARK";
  return quoteAge <= 5_000 ? "LIVE HYPERLIQUID MARK" : "QUOTE DELAYED";
}

function connectQuoteStream() {
  state.quoteStream?.close();
  const stream = new WebSocket(APP_CONFIG.websocketUrl);
  state.quoteStream = stream;
  stream.addEventListener("open", () => {
    if (state.quoteStream !== stream) return;
    state.quotedAsset = "";
    subscribeQuote(selectedMarket()?.id ?? "");
  });
  stream.addEventListener("message", ({ data }) => {
    if (state.quoteStream !== stream) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.data?.coin !== selectedMarket()?.id) return;
    if (message.channel === "activeAssetCtx") {
      const market = selectedMarket();
      Object.assign(market, applyLiveMarketContext(market, message.data.ctx));
      state.quoteUpdatedAt = Date.now();
      updateOrderPreview();
    }
    if (message.channel === "l2Book") {
      state.book = message.data;
      state.bookUpdatedAt = Date.now();
      updateOrderPreview();
    }
  });
  stream.addEventListener("close", () => {
    if (state.quoteStream !== stream) return;
    state.quoteUpdatedAt = 0;
    state.bookUpdatedAt = 0;
    state.book = null;
    updateOrderPreview();
    window.setTimeout(connectQuoteStream, 3_000);
  });
  stream.addEventListener("error", () => stream.close());
}

function subscribeQuote(asset) {
  const stream = state.quoteStream;
  if (!asset || stream?.readyState !== WebSocket.OPEN || asset === state.quotedAsset) return;
  if (state.quotedAsset) ["activeAssetCtx", "l2Book"].forEach((type) => stream.send(JSON.stringify({
    method: "unsubscribe", subscription: { type, coin: state.quotedAsset },
  })));
  state.quotedAsset = asset;
  state.quoteUpdatedAt = 0;
  state.bookUpdatedAt = 0;
  state.book = null;
  ["activeAssetCtx", "l2Book"].forEach((type) => stream.send(JSON.stringify({
    method: "subscribe", subscription: { type, coin: asset },
  })));
}

function render() {
  renderAccountOptions();
  const enabled = Boolean(state.user && state.account && APP_CONFIG.paperTradingEnabled && !state.pending);
  [...elements.form.elements].forEach((element) => { element.disabled = !enabled; });
  [...elements.accountForm.elements].forEach((element) => { element.disabled = state.pending; });
  paperAssetPicker.setDisabled(!enabled);
  elements.newAccount.disabled = !state.user || !APP_CONFIG.paperTradingEnabled || state.pending;
  elements.reset.disabled = !state.account || !APP_CONFIG.paperTradingEnabled || state.pending;
  elements.archive.disabled = !state.account || !APP_CONFIG.paperTradingEnabled || state.pending;
  renderStatus(!state.user ? "SIGN IN TO LOAD" : !APP_CONFIG.paperTradingEnabled ? "SHADOW MODE · TRADING DISABLED" : "LIVE PAPER ENGINE");
  const summary = state.epoch?.summary;
  state.feeRates = paperFeeRates(state.feeSchedule, summary?.trailing_volume, summary?.maker_volume);
  elements.metrics.innerHTML = summary ? metricStrip(summary) : "";
  elements.positions.innerHTML = table(["ASSET", "SIDE / SIZE", "ENTRY", "MARK", "UPNL", "MODE"], (state.epoch?.positions ?? []).map((position) => [displayAsset(position.asset), signed(position.signed_size), money(position.entry_price), money(position.mark_price), signedMoney(Number(position.signed_size) * (Number(position.mark_price) - Number(position.entry_price))), position.margin_mode.toUpperCase()]));
  elements.orders.innerHTML = table(["ASSET", "SIDE", "TYPE", "REMAINING", "PRICE", "STATUS", ""], (state.epoch?.orders ?? []).map((order) => [displayAsset(order.asset), order.side.toUpperCase(), order.order_type.toUpperCase(), formatPaperNumber(order.remaining_size, 6), money(order.limit_price ?? order.trigger_price), order.status.toUpperCase(), `<button type="button" data-order-id="${escapeHtml(order.id)}"${APP_CONFIG.paperTradingEnabled ? "" : " disabled"}>×</button>`]));
  elements.history.innerHTML = table(["TIME", "TYPE", "ASSET", "AMOUNT"], (state.epoch?.ledger ?? []).map((entry) => [new Date(entry.created_at).toLocaleString(), entry.entry_type.toUpperCase(), displayAsset(entry.asset ?? "—"), signedMoney(entry.amount)]));
  updateOrderFields();
}

function renderAccountOptions() {
  elements.account.innerHTML = state.accounts.length ? state.accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("") : "<option>NO ACCOUNT</option>";
  elements.account.disabled = !state.user || !state.accounts.length || state.pending;
  if (state.account) elements.account.value = state.account.id;
}

function metricStrip(summary) {
  return [["EQUITY", summary.equity], ["CASH", summary.cash_balance], ["UPNL", summary.unrealized_pnl], ["REALIZED", summary.realized_pnl], ["FUNDING", summary.cumulative_funding], ["FEES", summary.cumulative_fees], ["MARGIN", summary.margin_used]]
    .map(([label, value]) => `<span><small>${label}</small><strong class="${paperSignClass(value)}">${money(value)}</strong></span>`).join("");
}

function table(headers, rows) {
  if (!rows.length) return '<p class="hint">NONE</p>';
  return `<table class="paper-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function setPending(value) { state.pending = value; render(); }
function renderStatus(value) { elements.status.textContent = value; }
function fail(error) { elements.message.textContent = String(error?.message ?? error).toUpperCase(); }
function displayAsset(value) { return escapeHtml(String(value).replace(/^xyz:/, "")); }
function money(value, digits = 2) { return value === null || value === undefined ? "—" : `$${formatPaperNumber(value, digits)}`; }
function percentRate(value) { return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(4)}%` : "—"; }
function signed(value) { return `<span class="${paperSignClass(value)}">${Number(value) > 0 ? "+" : ""}${formatPaperNumber(value, 6)}</span>`; }
function signedMoney(value) { return `<span class="${paperSignClass(value)}">${Number(value) > 0 ? "+" : ""}$${formatPaperNumber(value, 2)}</span>`; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
