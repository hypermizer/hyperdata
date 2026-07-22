import { APP_CONFIG } from "./config.js?v=20260720-paper";
import { AssetPicker } from "./asset-picker.js?v=20260721-audio";
import { applyLiveMarketContext, postInfo } from "./lib/hyperliquid.js?v=20260722-position-controls";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260722-position-controls";
import {
  activePaperEpoch,
  combinePaperHistory,
  estimateIsolatedLiquidationPrice,
  estimateMarketFill,
  formatPaperPrice,
  formatPaperNumber,
  normalizeAccountName,
  normalizeLegacyPaperHistory,
  normalizePaperFeeSchedule,
  normalizePaperOrder,
  normalizeStartingCapital,
  paperFeeRates,
  paperHistoryViewUnavailable,
  paperInitialMargin,
  paperOrderHistoryCost,
  paperOrderReceipt,
  paperOrderSize,
  paperOrderPreview,
  paperPositionLiquidationPrice,
  paperPositionValue,
  paperPriceValid,
  paperSignClass,
  resolvePaperCommand,
  scalePerpFeeRate,
} from "./lib/paper.js?v=20260722-position-controls";
import { createWatchlistClient } from "./lib/supabase.js?v=20260721-strats";

const client = createWatchlistClient(APP_CONFIG);
const state = {
  user: null, accounts: [], epochs: [], account: null, epoch: null, pending: false,
  feeSchedule: null, feeRates: { maker: 0.00015, taker: 0.00045 },
  quoteStream: null, quotedAsset: "", quoteUpdatedAt: 0, bookUpdatedAt: 0, book: null,
  sizeMode: "shares", closeSizeMode: "shares", closePosition: null, markets: new Map(),
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
  sizeHelp: $("#paper-size-help"),
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
  closeDialog: $("#paper-close-dialog"), closeForm: $("#paper-close-form"),
  closePositionText: $("#paper-close-position"), closeMark: $("#paper-close-mark"),
  closeValue: $("#paper-close-value"), closeSize: $("#paper-close-size"),
  closeSizeUnit: $("#paper-close-size-unit"), closeSlider: $("#paper-close-slider"),
  closePercent: $("#paper-close-percent"), closeShares: $("#paper-close-shares"),
  closeFill: $("#paper-close-fill"), closeNotional: $("#paper-close-notional"),
  closeFee: $("#paper-close-fee"), closeValidation: $("#paper-close-validation"),
  closeSubmit: $("#paper-close-submit"), closeMessage: $("#paper-close-message"),
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
  elements.positions.addEventListener("click", openCloseDialog);
  elements.closeForm.addEventListener("submit", closePaperPosition);
  elements.closeForm.addEventListener("input", handleCloseInput);
  elements.closeForm.addEventListener("change", handleCloseInput);
  document.querySelectorAll("[data-close-paper-position]").forEach((button) => button.addEventListener("click", closeCloseDialog));
  elements.closeDialog.addEventListener("close", () => {
    state.closePosition = null;
    subscribeQuote(selectedMarket()?.id ?? "");
  });
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
  state.markets = new Map(catalog.map((market) => [market.id, market]));
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

async function loadAccounts(preferredId = state.account?.id, options = {}) {
  const [accountsResponse, epochsResponse] = await Promise.all([
    client.from("paper_accounts").select("*").is("archived_at", null).not("name", "like", "__SHADOW__%").order("created_at"),
    client.from("paper_account_epochs").select("*").eq("state", "active"),
  ]);
  if (accountsResponse.error || epochsResponse.error) {
    const error = accountsResponse.error ?? epochsResponse.error;
    if (options.throwOnError) throw error;
    reportPaperSyncError(error); return false;
  }
  state.accounts = accountsResponse.data ?? [];
  state.epochs = epochsResponse.data ?? [];
  const selected = state.accounts.find((account) => account.id === preferredId) ?? state.accounts[0] ?? null;
  state.account = selected;
  state.epoch = activePaperEpoch(selected, state.epochs);
  renderAccountOptions();
  if (selected) return loadAccountState(options);
  render(); return true;
}

async function selectAccount(id) {
  state.account = state.accounts.find((account) => account.id === id) ?? null;
  state.epoch = activePaperEpoch(state.account, state.epochs);
  await loadAccountState();
}

async function loadAccountState(options = {}) {
  if (!state.epoch) { render(); return true; }
  const epochId = state.epoch.id;
  const [epoch, summary, positions, orders, ledger, orderHistory, leverageSettings, feeVolume] = await Promise.all([
    client.from("paper_account_epochs").select("version,epoch_number,state").eq("id", epochId).single(),
    client.from("paper_account_summaries").select("*").eq("epoch_id", epochId).single(),
    client.from("paper_positions").select("*").eq("epoch_id", epochId).order("asset"),
    client.from("paper_orders").select("*").eq("epoch_id", epochId).in("status", ["resting", "partially_filled", "trigger_waiting"]).order("created_at", { ascending: false }),
    loadPaperHistory(epochId),
    loadPaperOrderHistory(epochId),
    client.from("paper_leverage_settings").select("asset,leverage").eq("epoch_id", epochId),
    client.rpc("paper_fee_volume", { p_epoch_id: epochId }).single(),
  ]);
  const error = epoch.error ?? summary.error ?? positions.error ?? orders.error ?? ledger.error ?? orderHistory.error ?? leverageSettings.error ?? feeVolume.error;
  if (error) {
    if (options.throwOnError) throw error;
    reportPaperSyncError(error); return false;
  }
  state.epoch = {
    ...state.epoch, ...epoch.data,
    summary: { ...summary.data, trailing_volume: feeVolume.data.trailing_volume, maker_volume: feeVolume.data.maker_volume },
    positions: positions.data ?? [], orders: orders.data ?? [],
    history: combinePaperHistory(ledger.data, orderHistory.data),
    leverageSettings: leverageSettings.data ?? [],
  };
  if (state.closePosition) {
    state.closePosition = state.epoch.positions.find(({ asset }) => asset === state.closePosition.asset) ?? null;
    if (!state.closePosition && elements.closeDialog.open) elements.closeDialog.close();
  }
  render();
  return true;
}

async function loadPaperOrderHistory(epochId) {
  const history = await client.from("paper_order_history").select("*").eq("epoch_id", epochId)
    .order("event_at", { ascending: false }).limit(100);
  return history.error && paperHistoryViewUnavailable(history.error) ? { data: [], error: null } : history;
}

async function loadPaperHistory(epochId) {
  const history = await client.from("paper_ledger_history").select("*").eq("epoch_id", epochId)
    .order("created_at", { ascending: false }).limit(100);
  if (!history.error || !paperHistoryViewUnavailable(history.error)) return history;
  const legacy = await client.from("paper_ledger_entries").select("*").eq("epoch_id", epochId)
    .order("created_at", { ascending: false }).limit(100);
  return legacy.error ? history : { data: normalizeLegacyPaperHistory(legacy.data), error: null };
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
  event.preventDefault(); setPaperMessage();
  try {
    if (!APP_CONFIG.paperTradingEnabled) throw new Error("PAPER TRADING IS IN SHADOW MODE.");
    if (!state.account || !state.epoch) throw new Error("Create an account first.");
    const formData = new FormData(elements.form);
    const form = Object.fromEntries(formData);
    form.asset = paperAssetPicker.value;
    form.reduceOnly = formData.has("reduceOnly");
    const market = selectedMarket();
    form.size = previewOrder().shareSize ?? "";
    const order = normalizePaperOrder(form, market?.maxLeverage ?? Infinity);
    const { receiptText, receipt } = await submitPaperOrder(order);
    setPaperMessage(receiptText, receipt.tone);
    elements.size.value = "";
    elements.sizeSlider.value = "0";
    updateLeverageLimit(true);
  } catch (error) {
    setPaperMessage(orderFailureText(error), error?.outcomeUnknown ? "warning" : "error");
    if (state.account) await loadAccounts(state.account.id);
  } finally { setPending(false); }
}

async function submitPaperOrder(order) {
  const idempotencyKey = crypto.randomUUID();
  const epochId = state.epoch.id;
  setPending(true);
  try {
    const { data, reconciled } = await resolvePaperCommand(
      () => client.functions.invoke("paper-command", { body: {
        type: "place_order", accountId: state.account.id, epochNumber: state.epoch.epoch_number,
        expectedVersion: Number(state.epoch.version), idempotencyKey, order,
      } }),
      async () => {
        const result = await client.from("paper_commands").select("canonical_result")
          .eq("epoch_id", epochId).eq("idempotency_key", idempotencyKey).maybeSingle();
        if (result.error) throw result.error;
        return result.data?.canonical_result ?? null;
      },
    );
    const receipt = paperOrderReceipt(data);
    const receiptText = `${receipt.text} · ID ${idempotencyKey.slice(0, 8).toUpperCase()}${reconciled ? " · VERIFIED" : ""}`;
    try {
      await loadAccounts(state.account.id, { throwOnError: true });
    } catch {
      return { receipt, receiptText: `${receiptText} · ACCOUNT REFRESH DELAYED` };
    }
    return { receipt, receiptText };
  } catch (error) {
    error.idempotencyKey = idempotencyKey;
    throw error;
  }
}

function orderFailureText(error) {
  const id = String(error?.idempotencyKey ?? "").slice(0, 8).toUpperCase();
  return error?.outcomeUnknown
    ? `ORDER OUTCOME UNKNOWN — DO NOT RESUBMIT${id ? ` · ID ${id}` : ""}`
    : `ORDER FAILED — ${String(error?.message ?? error).toUpperCase()}`;
}

async function cancelOrder(event) {
  const button = event.target.closest("button[data-order-id]");
  if (!button || !state.account || !APP_CONFIG.paperTradingEnabled) return;
  await runAccountRpc("cancel_paper_order", { p_account_id: state.account.id, p_order_id: button.dataset.orderId }, state.account.id);
}

function openCloseDialog(event) {
  const button = event.target.closest("button[data-close-asset]");
  if (!button || state.pending) return;
  const position = state.epoch?.positions?.find(({ asset }) => asset === button.dataset.closeAsset);
  if (!position) return;
  state.closePosition = position;
  state.closeSizeMode = "shares";
  elements.closeForm.elements.closeSizeMode.value = "shares";
  elements.closeSlider.value = "100";
  elements.closeSize.value = compactSize(Math.abs(Number(position.signed_size)), marketForAsset(position.asset)?.sizeDecimals);
  elements.closeMessage.textContent = "";
  if (!elements.closeDialog.open) elements.closeDialog.showModal();
  subscribeQuote(position.asset);
  updateClosePreview();
  elements.closeSize.select();
}

function closeCloseDialog() {
  if (elements.closeDialog.open) elements.closeDialog.close();
  state.closePosition = null;
  subscribeQuote(selectedMarket()?.id ?? "");
}

function handleCloseInput(event) {
  if (event.target.name === "closeSizeMode") {
    const preview = previewClose();
    state.closeSizeMode = event.target.value === "usdc" ? "usdc" : "shares";
    if (preview.shareSize !== null) {
      elements.closeSize.value = state.closeSizeMode === "usdc"
        ? usdcAmountForShares(preview.shareSize, preview.markPrice)
        : preview.shareSize;
    }
  } else if (event.target === elements.closeSlider) {
    setCloseSizeFromPercent(Number(elements.closeSlider.value));
    return;
  }
  updateClosePreview();
}

function setCloseSizeFromPercent(percent) {
  const position = state.closePosition;
  const market = marketForAsset(position?.asset);
  if (!position || !market) return;
  const maximum = Math.abs(Number(position.signed_size));
  const bounded = Math.max(0, Math.min(100, percent));
  const decimals = Math.max(0, Math.min(8, Number(market.sizeDecimals) || 0));
  const scale = 10 ** decimals;
  const shares = bounded === 100 ? maximum : Math.floor(maximum * bounded / 100 * scale) / scale;
  elements.closeSize.value = state.closeSizeMode === "usdc"
    ? usdcAmountForShares(shares, livePositionMark(position))
    : compactSize(shares, decimals);
  updateClosePreview();
}

function previewClose() {
  const position = state.closePosition;
  const market = marketForAsset(position?.asset);
  const markPrice = livePositionMark(position);
  const maximum = Math.abs(Number(position?.signed_size));
  const shareSize = paperOrderSize(elements.closeSize.value, state.closeSizeMode, markPrice, market?.sizeDecimals);
  const size = Number(shareSize);
  const side = Number(position?.signed_size) > 0 ? "sell" : "buy";
  const hasFreshBook = state.bookUpdatedAt > 0 && Date.now() - state.bookUpdatedAt <= 5_000;
  const bestBid = Number(state.book?.levels?.[0]?.[0]?.px);
  const bestAsk = Number(state.book?.levels?.[1]?.[0]?.px);
  const bookMid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : markPrice;
  const fill = estimateMarketFill(
    hasFreshBook && side === "buy" ? state.book?.levels?.[1] : hasFreshBook ? state.book?.levels?.[0] : [],
    shareSize, markPrice, side, 5, bookMid,
  );
  const executionPrice = fill?.averagePrice ?? markPrice;
  const notional = Number.isFinite(size) && executionPrice > 0 ? size * executionPrice : null;
  const fee = notional === null ? null : notional * selectedFeeRates(market).taker;
  return { position, market, markPrice, maximum, shareSize, size, side, fill, executionPrice, notional, fee };
}

function updateClosePreview() {
  const preview = previewClose();
  const { position, market, markPrice, maximum, size, fill, notional, fee } = preview;
  if (!position || !market) return;
  const quoteAge = state.quoteUpdatedAt ? Date.now() - state.quoteUpdatedAt : null;
  const validSize = Number.isFinite(size) && size > 0 && size <= maximum + Number.EPSILON;
  const precisionValid = state.closeSizeMode === "usdc" || decimalPlaces(elements.closeSize.value) <= Number(market.sizeDecimals ?? 0);
  const fresh = quoteAge !== null && quoteAge <= 5_000;
  const valid = Boolean(state.user && state.account && APP_CONFIG.paperTradingEnabled && !state.pending
    && validSize && precisionValid && fresh && fill && notional >= 10);
  const percent = maximum > 0 && Number.isFinite(size) ? Math.max(0, Math.min(100, size / maximum * 100)) : 0;

  elements.closePositionText.textContent = `${Number(position.signed_size) > 0 ? "LONG" : "SHORT"} ${formatPaperNumber(maximum, market.sizeDecimals)} ${market.symbol}`;
  elements.closeMark.textContent = formatPaperPrice(markPrice);
  elements.closeValue.textContent = money(paperPositionValue(position, markPrice));
  elements.closeSizeUnit.textContent = state.closeSizeMode === "usdc" ? "USDC" : market.symbol;
  elements.closeShares.textContent = Number.isFinite(size) ? `${formatPaperNumber(size, market.sizeDecimals)} ${market.symbol}` : "—";
  elements.closeFill.textContent = fill ? formatPaperPrice(fill.averagePrice) : "AWAITING BOOK";
  elements.closeNotional.textContent = money(notional);
  elements.closeFee.textContent = money(fee, 4);
  elements.closePercent.textContent = `${Math.round(percent)}%`;
  if (document.activeElement !== elements.closeSlider) elements.closeSlider.value = String(Math.round(percent));
  elements.closeSubmit.disabled = !valid;
  if (!validSize) elements.closeValidation.textContent = `ENTER BETWEEN 0 AND ${formatPaperNumber(maximum, market.sizeDecimals)} ${market.symbol}`;
  else if (!precisionValid) elements.closeValidation.textContent = `${market.symbol} SUPPORTS ${market.sizeDecimals} SIZE DECIMALS`;
  else if (notional < 10) elements.closeValidation.textContent = "HYPERLIQUID MINIMUM ORDER VALUE IS $10";
  else if (!fresh) elements.closeValidation.textContent = "WAITING FOR A LIVE HYPERLIQUID MARK";
  else if (!fill) elements.closeValidation.textContent = "WAITING FOR THE LIVE ORDER BOOK";
  else elements.closeValidation.textContent = `${Math.round(percent)}% · REDUCE ONLY · MARKET`;
}

async function closePaperPosition(event) {
  event.preventDefault();
  const preview = previewClose();
  const position = preview.position;
  if (!position || !preview.market) return;
  try {
    const leverage = Number(state.epoch?.leverageSettings?.find(({ asset }) => asset === position.asset)?.leverage)
      || preview.market.maxLeverage || 1;
    const order = normalizePaperOrder({
      asset: position.asset, side: preview.side, size: preview.shareSize,
      orderType: "market", timeInForce: null, limitPrice: null, triggerPrice: null,
      leverage, marginMode: position.margin_mode, reduceOnly: true,
    }, preview.market.maxLeverage ?? Infinity);
    const { receiptText, receipt } = await submitPaperOrder(order);
    closeCloseDialog();
    setPaperMessage(receiptText, receipt.tone);
  } catch (error) {
    elements.closeMessage.textContent = orderFailureText(error);
    elements.closeMessage.dataset.tone = error?.outcomeUnknown ? "warning" : "error";
    if (state.account) await loadAccounts(state.account.id);
  } finally {
    setPending(false);
    updateClosePreview();
  }
}

function updateOrderFields() {
  const type = selectedOrderType();
  const locked = !state.user || !state.account || !APP_CONFIG.paperTradingEnabled || state.pending;
  const isLimit = type === "limit";
  elements.limitFields.hidden = !isLimit;
  elements.form.elements.limitPrice.disabled = locked || !isLimit;
  elements.form.elements.timeInForce.disabled = locked || !isLimit;
  const cross = elements.form.querySelector('input[name="marginMode"][value="cross"]');
  const isolated = elements.form.querySelector('input[name="marginMode"][value="isolated"]');
  if (selectedMarket()?.onlyIsolated) isolated.checked = true;
  cross.disabled = locked || selectedMarket()?.onlyIsolated === true;
  isolated.disabled = locked;
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
  updateSizeLabels();
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
  if (event.target.name === "sizeMode") {
    changeSizeMode(event.target.value);
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
  if (state.sizeMode === "usdc") {
    elements.size.value = usdcAmountForShares(size, preview.inputPrice);
  } else {
    elements.size.value = size > 0 ? String(size) : "";
  }
  updateOrderPreview();
}

function changeSizeMode(nextMode) {
  const preview = previewOrder();
  const shareSize = preview.shareSize;
  state.sizeMode = nextMode === "usdc" ? "usdc" : "shares";
  if (shareSize !== null) {
    elements.size.value = state.sizeMode === "usdc"
      ? usdcAmountForShares(shareSize, preview.inputPrice)
      : shareSize;
  }
  updateSizeLabels();
  updateOrderPreview();
}

function usdcAmountForShares(shares, price) {
  const amount = Number(shares) * Number(price);
  return amount > 0 ? String(Math.ceil((amount - Number.EPSILON) * 100) / 100) : "";
}

function updateSizeLabels() {
  const symbol = selectedMarket()?.symbol ?? "SHARES";
  elements.sizeUnit.textContent = state.sizeMode === "usdc" ? "USDC" : symbol;
  elements.sizeHelp.textContent = state.sizeMode === "usdc"
    ? "ENTER ORDER VALUE IN USDC"
    : `ENTER THE NUMBER OF ${symbol} SHARES`;
}

function previewOrder() {
  const market = selectedMarket();
  const summary = state.epoch?.summary;
  const positionRecord = state.epoch?.positions?.find(({ asset }) => asset === market?.id);
  const currentPosition = Number(positionRecord?.signed_size) || 0;
  const persistedLeverage = Number(state.epoch?.leverageSettings?.find(({ asset }) => asset === market?.id)?.leverage) || 1;
  const currentMargin = positionRecord?.margin_mode === "isolated"
    ? Number(positionRecord.isolated_margin || 0)
    : paperInitialMargin(Math.abs(currentPosition) * Number(positionRecord?.mark_price || market?.markPrice || 0), persistedLeverage, market?.marginTiers);
  const reservedMargin = (state.epoch?.orders ?? []).reduce((total, order) => total + Number(order.reserved_margin || 0), 0);
  const availableMargin = Math.max(0, Number(summary?.equity || 0) - Number(summary?.margin_used || 0) - reservedMargin);
  const orderType = selectedOrderType();
  const side = selectedSide();
  const inputPrice = orderType === "limit" ? elements.limitPrice.value : (market?.markPriceRaw ?? market?.markPrice);
  const shareSize = paperOrderSize(elements.size.value, state.sizeMode, inputPrice, market?.sizeDecimals);
  const hasFreshBook = state.bookUpdatedAt > 0 && Date.now() - state.bookUpdatedAt <= 5_000;
  const bestBid = Number(state.book?.levels?.[0]?.[0]?.px);
  const bestAsk = Number(state.book?.levels?.[1]?.[0]?.px);
  const bookMid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : market?.markPrice;
  const marketFill = orderType === "market"
    ? estimateMarketFill(hasFreshBook && side === "buy" ? state.book?.levels?.[1]
      : hasFreshBook ? state.book?.levels?.[0] : [], shareSize, market?.markPrice, side, 5, bookMid)
    : null;
  const rates = selectedFeeRates(market);
  const feeRate = limitLiquidity(side) === "maker" ? rates.maker : rates.taker;
  const preview = paperOrderPreview({
    size: shareSize,
    markPrice: market?.markPrice,
    executionPrice: marketFill?.averagePrice,
    limitPrice: elements.limitPrice.value,
    orderType,
    leverage: elements.leverage.value,
    feeRate,
    availableMargin,
    currentMargin,
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
    shareSize,
    inputPrice,
    feeRates: rates,
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
  const size = Number(preview.shareSize);
  const enabled = Boolean(state.user && state.account && APP_CONFIG.paperTradingEnabled && !state.pending);
  const hasAmount = Number.isFinite(size) && size > 0;
  const hasPrice = Number.isFinite(preview.price) && preview.price > 0;
  const hasFreshQuote = quoteAge !== null && quoteAge <= 5_000;
  const hasExecutionPreview = orderType === "limit" || Boolean(preview.marketFill);
  const withinCapacity = preview.maxSize === null || size <= preview.maxSize + Number.EPSILON;
  const sizePrecisionValid = state.sizeMode === "usdc" || decimalPlaces(elements.size.value) <= Number(market?.sizeDecimals ?? 0);
  const pricePrecisionValid = orderType !== "limit" || paperPriceValid(elements.limitPrice.value, market?.sizeDecimals);
  const minimumNotionalValid = preview.orderValue === null || preview.orderValue >= 10;
  const valid = enabled && Boolean(market) && hasAmount && hasPrice && hasFreshQuote && hasExecutionPreview
    && withinCapacity && sizePrecisionValid && pricePrecisionValid && minimumNotionalValid;

  elements.livePrice.textContent = money(market?.markPrice);
  elements.liveStatus.textContent = quoteStatus(market, quoteAge);
  elements.availableMargin.textContent = market ? money(preview.availableMargin) : "—";
  elements.currentPosition.textContent = market ? `${formatPaperNumber(preview.currentPosition, market.sizeDecimals ?? 4)} ${market.symbol}` : "—";
  elements.orderPrice.textContent = money(preview.price);
  elements.orderValue.textContent = money(preview.orderValue);
  elements.marginRequired.textContent = money(preview.marginRequired);
  elements.estimatedFee.textContent = money(preview.estimatedFee, 4);
  elements.estimatedCost.textContent = money(preview.estimatedCost, 4);
  elements.feeRates.textContent = `${percentRate(preview.feeRates.maker)} / ${percentRate(preview.feeRates.taker)}`;
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
  else if (!hasAmount) elements.validation.textContent = `ENTER AN AMOUNT LARGE ENOUGH FOR 1 ${market.symbol} SIZE INCREMENT`;
  else if (!sizePrecisionValid) elements.validation.textContent = `${market.symbol} SUPPORTS ${market.sizeDecimals} SIZE DECIMALS`;
  else if (!pricePrecisionValid) elements.validation.textContent = `PRICE MUST USE AT MOST 5 SIGNIFICANT FIGURES AND ${Math.max(0, 6 - market.sizeDecimals)} DECIMALS`;
  else if (!minimumNotionalValid) elements.validation.textContent = "HYPERLIQUID MINIMUM ORDER VALUE IS $10";
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

function selectedFeeRates(market) {
  return {
    maker: scalePerpFeeRate(state.feeRates.maker, market, "maker"),
    taker: scalePerpFeeRate(state.feeRates.taker, market, "taker"),
  };
}

function limitLiquidity(side) {
  if (selectedOrderType() === "market") return "taker";
  if (elements.form.elements.timeInForce.value === "ALO") return "maker";
  const price = Number(elements.limitPrice.value);
  const best = Number(side === "buy" ? state.book?.levels?.[1]?.[0]?.px : state.book?.levels?.[0]?.[0]?.px);
  if (!Number.isFinite(price) || !Number.isFinite(best)) return "taker";
  return side === "buy" ? (price >= best ? "taker" : "maker") : (price <= best ? "taker" : "maker");
}

function decimalPlaces(value) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]) || 0;
  return text.includes(".") ? text.split(".")[1].length : 0;
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
    subscribeQuote(activeQuoteAsset());
  });
  stream.addEventListener("message", ({ data }) => {
    if (state.quoteStream !== stream) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    const activeAsset = activeQuoteAsset();
    if (message.data?.coin !== activeAsset) return;
    if (message.channel === "activeAssetCtx") {
      const market = marketForAsset(activeAsset);
      if (!market) return;
      Object.assign(market, applyLiveMarketContext(market, message.data.ctx));
      state.quoteUpdatedAt = Date.now();
      if (state.closePosition) updateClosePreview();
      else updateOrderPreview();
    }
    if (message.channel === "l2Book") {
      state.book = message.data;
      state.bookUpdatedAt = Date.now();
      if (state.closePosition) updateClosePreview();
      else updateOrderPreview();
    }
  });
  stream.addEventListener("close", () => {
    if (state.quoteStream !== stream) return;
    state.quoteUpdatedAt = 0;
    state.bookUpdatedAt = 0;
    state.book = null;
    if (state.closePosition) updateClosePreview();
    else updateOrderPreview();
    window.setTimeout(connectQuoteStream, 3_000);
  });
  stream.addEventListener("error", () => stream.close());
}

function activeQuoteAsset() { return state.closePosition?.asset ?? selectedMarket()?.id ?? ""; }
function marketForAsset(asset) { return state.markets.get(asset) ?? null; }
function livePositionMark(position) {
  const live = Number(marketForAsset(position?.asset)?.markPrice);
  const hasFreshLiveMark = state.quotedAsset === position?.asset
    && state.quoteUpdatedAt > 0 && Date.now() - state.quoteUpdatedAt <= 5_000;
  return hasFreshLiveMark && live > 0 ? live : Number(position?.mark_price) || null;
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
  const positions = (state.epoch?.positions ?? []).map((position) => ({ ...position, mark_price: livePositionMark(position) }));
  const marginTiersByAsset = Object.fromEntries([...state.markets].map(([asset, market]) => [asset, market.marginTiers]));
  elements.positions.innerHTML = table(["ASSET", "SIDE / SIZE", "ENTRY", "MARK", "VALUE", "UPNL", "LIQ. PRICE", "MODE", ""], positions.map((position) => {
    const liquidationPrice = paperPositionLiquidationPrice({
      position, positions, cashBalance: summary?.cash_balance, marginTiersByAsset,
    });
    return [
      displayAsset(position.asset), signed(position.signed_size), formatPaperPrice(position.entry_price), formatPaperPrice(position.mark_price),
      money(paperPositionValue(position)), signedMoney(Number(position.signed_size) * (Number(position.mark_price) - Number(position.entry_price))),
      formatPaperPrice(liquidationPrice), escapeHtml(position.margin_mode.toUpperCase()),
      `<button class="paper-close-button" type="button" data-close-asset="${escapeHtml(position.asset)}"${enabled ? "" : " disabled"}>CLOSE</button>`,
    ];
  }));
  elements.orders.innerHTML = table(["ASSET", "SIDE", "TYPE", "REMAINING", "PRICE", "STATUS", ""], (state.epoch?.orders ?? []).map((order) => [displayAsset(order.asset), order.side.toUpperCase(), order.order_type.toUpperCase(), formatPaperNumber(order.remaining_size, 6), money(order.limit_price ?? order.trigger_price), order.status.toUpperCase(), `<button type="button" data-order-id="${escapeHtml(order.id)}"${APP_CONFIG.paperTradingEnabled ? "" : " disabled"}>×</button>`]));
  elements.history.innerHTML = table(["TIME", "TYPE", "ASSET", "SIDE", "ENTRY PRICE", "AMOUNT", "NOTIONAL", "COST / CASH", "FEES", "STATUS"], (state.epoch?.history ?? []).map(historyRow));
  updateOrderFields();
  if (state.closePosition) updateClosePreview();
}

function historyRow(entry) {
  if (entry.history_kind !== "order") return [
    new Date(entry.event_at).toLocaleString(), escapeHtml(entry.entry_type.toUpperCase()), displayAsset(entry.asset ?? "—"),
    "—", formatPaperPrice(entry.asset_price), "—", "—", signedMoney(entry.amount), "—", "—",
  ];
  const filled = Number(entry.filled_size) || 0;
  const requested = Number(entry.requested_size) || 0;
  const side = entry.reduce_only
    ? (entry.side === "sell" ? "CLOSE LONG" : "CLOSE SHORT")
    : (entry.side === "sell" ? "SHORT" : "LONG");
  const amount = filled > 0 && Math.abs(filled - requested) > Number.EPSILON
    ? `${formatPaperNumber(filled, 6)} / ${formatPaperNumber(requested, 6)}`
    : formatPaperNumber(requested, 6);
  return [
    new Date(entry.event_at).toLocaleString(), `${escapeHtml(entry.order_type.toUpperCase())} ORDER`, displayAsset(entry.asset), side,
    formatPaperPrice(entry.entry_price ?? entry.limit_price ?? entry.trigger_price), amount, money(entry.notional),
    money(paperOrderHistoryCost(entry), 4), money(entry.fees, 4), escapeHtml(entry.status.toUpperCase()),
  ];
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
function setPaperMessage(text = "", tone = "") {
  elements.message.textContent = text;
  if (tone) elements.message.dataset.tone = tone;
  else delete elements.message.dataset.tone;
}
function reportPaperSyncError(error) {
  renderStatus(`SYNC ERROR · ${String(error?.message ?? error).toUpperCase()}`);
}
function fail(error) { setPaperMessage(String(error?.message ?? error).toUpperCase(), "error"); }
function displayAsset(value) { return escapeHtml(String(value).replace(/^xyz:/, "")); }
function money(value, digits = 2) { return value === null || value === undefined ? "—" : `$${formatPaperNumber(value, digits)}`; }
function compactSize(value, digits = 8) { return Number(value).toFixed(Math.max(0, Math.min(8, Number(digits) || 0))).replace(/\.?0+$/, ""); }
function percentRate(value) { return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(4)}%` : "—"; }
function signed(value) { return `<span class="${paperSignClass(value)}">${Number(value) > 0 ? "+" : ""}${formatPaperNumber(value, 6)}</span>`; }
function signedMoney(value) { return `<span class="${paperSignClass(value)}">${Number(value) > 0 ? "+" : ""}$${formatPaperNumber(value, 2)}</span>`; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
