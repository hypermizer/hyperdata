import { APP_CONFIG } from "./config.js?v=20260720-paper";
import { AssetPicker } from "./asset-picker.js?v=20260720-stream";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260720-assets";
import { activePaperEpoch, formatPaperNumber, normalizeAccountName, normalizePaperOrder, normalizeStartingCapital, paperSignClass } from "./lib/paper.js?v=20260720-assets";
import { createWatchlistClient } from "./lib/supabase.js?v=20260720-paper";

const client = createWatchlistClient(APP_CONFIG);
const state = { user: null, accounts: [], epochs: [], account: null, epoch: null, pending: false };
const $ = (selector) => document.querySelector(selector);
const elements = {
  account: $("#paper-account"), newAccount: $("#paper-new-account"), reset: $("#paper-reset-account"),
  archive: $("#paper-archive-account"), status: $("#paper-status"), metrics: $("#paper-metrics"),
  form: $("#paper-order-form"), message: $("#paper-message"), positions: $("#paper-positions"),
  orders: $("#paper-orders"), history: $("#paper-history"), orderType: $("#paper-order-type"),
  accountDialog: $("#paper-account-dialog"), accountForm: $("#paper-account-form"),
  accountMessage: $("#paper-account-message"), accountName: $("#paper-account-name"),
  startingCapital: $("#paper-starting-capital"),
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
  elements.orderType.addEventListener("change", updateOrderFields);
  setInterval(() => { if (!document.hidden && state.user && state.account) loadAccountState(); }, 5_000);
}

async function initialize() {
  if (!client) return renderStatus("STORAGE UNAVAILABLE");
  const [catalog, { data }] = await Promise.all([getMarketCatalog(), client.auth.getSession()]);
  paperAssetPicker.setCatalog(catalog);
  await setSession(data.session);
  client.auth.onAuthStateChange((_event, session) => setTimeout(() => setSession(session), 0));
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
    setPending(true);
    const formData = new FormData(elements.form);
    const form = Object.fromEntries(formData);
    form.asset = paperAssetPicker.value;
    form.reduceOnly = formData.has("reduceOnly");
    const order = normalizePaperOrder(form);
    const { data, error } = await client.functions.invoke("paper-command", { body: {
      type: "place_order", accountId: state.account.id, epochNumber: state.epoch.epoch_number,
      expectedVersion: Number(state.epoch.version), idempotencyKey: crypto.randomUUID(), order,
    } });
    if (error) throw error;
    elements.message.textContent = String(data?.response?.status ?? "ORDER ACCEPTED").toUpperCase();
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
  const type = elements.orderType.value;
  const locked = !state.user || !state.account || !APP_CONFIG.paperTradingEnabled || state.pending;
  elements.form.elements.limitPrice.disabled = locked || !type.includes("limit");
  elements.form.elements.triggerPrice.disabled = locked || !(type.startsWith("stop_") || type.startsWith("take_"));
  elements.form.elements.timeInForce.disabled = locked || type === "market" || type.endsWith("_market");
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
function money(value) { return value === null ? "—" : `$${formatPaperNumber(value, 2)}`; }
function signed(value) { return `<span class="${paperSignClass(value)}">${Number(value) > 0 ? "+" : ""}${formatPaperNumber(value, 6)}</span>`; }
function signedMoney(value) { return `<span class="${paperSignClass(value)}">${Number(value) > 0 ? "+" : ""}$${formatPaperNumber(value, 2)}</span>`; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
