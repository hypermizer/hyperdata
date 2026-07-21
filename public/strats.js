import { APP_CONFIG } from "./config.js?v=20260721-strats";
import { AssetPicker } from "./asset-picker.js?v=20260721-audio";
import { getMarketCatalog } from "./lib/market-catalog.js?v=20260723-sizing-audit";
import { createWatchlistClient } from "./lib/supabase.js?v=20260721-strats";
import { displayStrategyAsset, escapeStrategyHtml, money, strategyRuleSummary, strategyStateLabel, summarizeBacktest } from "./lib/strats.js?v=20260721-strats";

const client = createWatchlistClient(APP_CONFIG);
const state = { user: null, definitions: [], revisions: [], assignments: [], accounts: [], evaluations: [], positions: [], runs: [], pending: false, pauseAssignmentId: null };
const $ = (selector) => document.querySelector(selector);
const elements = {
  status: $("#strats-status"), rule: $("#strats-rule"), definitionForm: $("#strats-definition-form"),
  assignmentForm: $("#strats-assignment-form"), backtestForm: $("#strats-backtest-form"),
  definition: $("#strats-definition"), account: $("#strats-account"), revision: $("#strats-revision"),
  assignments: $("#strats-assignments"), backtests: $("#strats-backtests"), message: $("#strats-message"),
  pauseDialog: $("#strats-pause-dialog"), start: $("#strats-start"), end: $("#strats-end"), view: $("#strats-view"),
};
const assetPicker = new AssetPicker($("#strats-asset-picker"), { details: "none" });

wire();
initialize();

function wire() {
  elements.definitionForm.addEventListener("submit", createDefinition);
  elements.assignmentForm.addEventListener("submit", createAssignment);
  elements.backtestForm.addEventListener("submit", queueBacktest);
  elements.assignments.addEventListener("click", assignmentAction);
  $("[data-close-strats-pause]").addEventListener("click", () => elements.pauseDialog.close());
  elements.pauseDialog.addEventListener("click", pauseChoice);
  window.setInterval(() => { if (!document.hidden && !elements.view.hidden && state.user) load(); }, 5_000);
}

async function initialize() {
  const end = new Date();
  const start = new Date(end.getTime() - 17 * 86_400_000);
  elements.end.value = end.toISOString().slice(0, 10);
  elements.start.value = start.toISOString().slice(0, 10);
  elements.rule.textContent = strategyRuleSummary();
  if (!client) { elements.status.textContent = "STORAGE UNAVAILABLE"; return; }
  const [catalog, { data }] = await Promise.all([getMarketCatalog(), client.auth.getSession()]);
  assetPicker.setCatalog(catalog);
  await setSession(data.session);
  client.auth.onAuthStateChange((_event, session) => setTimeout(() => setSession(session), 0));
}

async function setSession(session) {
  state.user = session?.user?.email === APP_CONFIG.allowedEmail ? session.user : null;
  if (!state.user) { clearState(); render(); return; }
  await load();
}

function clearState() {
  state.definitions = []; state.revisions = []; state.assignments = []; state.accounts = [];
  state.evaluations = []; state.positions = []; state.runs = [];
}

async function load() {
  const responses = await Promise.all([
    client.from("strategy_definitions").select("*").is("archived_at", null).order("created_at"),
    client.from("strategy_revisions").select("*").order("created_at"),
    client.from("strategy_assignments").select("*").order("created_at"),
    client.from("paper_accounts").select("id,name,active_epoch").is("archived_at", null).not("name", "like", "__SHADOW__%").order("created_at"),
    client.from("strategy_evaluations").select("*").order("created_at", { ascending: false }).limit(200),
    client.from("strategy_positions").select("*").in("state", ["open", "closing"]),
    client.from("backtest_runs").select("id,revision_id,assets,requested_start,requested_end,actual_start,actual_end,initial_capital,status,progress,fidelity,assumptions,metrics,failure_reason,created_at,finished_at").order("created_at", { ascending: false }).limit(30),
  ]);
  const failed = responses.find((response) => response.error);
  if (failed) { elements.status.textContent = `SYNC ERROR · ${String(failed.error.message).toUpperCase()}`; return; }
  [state.definitions,state.revisions,state.assignments,state.accounts,state.evaluations,state.positions,state.runs] = responses.map((response) => response.data ?? []);
  render();
}

async function invoke(command) {
  if (!APP_CONFIG.strategyCommandsEnabled) throw new Error("STRATEGY COMMANDS DISABLED");
  const { data, error } = await client.functions.invoke("strategy-command", { body: command });
  if (error) throw new Error(error.context?.body?.detail ?? error.message);
  if (data?.error) throw new Error(data.detail ?? data.error);
  return data?.result;
}

async function createDefinition(event) {
  event.preventDefault();
  const form = new FormData(elements.definitionForm);
  await runCommand({ type: "create_definition", name: form.get("name"), marginAllocationPct: Number(form.get("marginAllocationPct")) }, "STRATEGY CREATED");
}

async function createAssignment(event) {
  event.preventDefault();
  const form = new FormData(elements.assignmentForm);
  await runCommand({ type: "create_assignment", definitionId: form.get("definitionId"), accountId: form.get("accountId"), asset: assetPicker.value, marginAllocationPct: Number(form.get("marginAllocationPct")) }, "PAUSED ASSIGNMENT CREATED");
}

async function queueBacktest(event) {
  event.preventDefault();
  const form = new FormData(elements.backtestForm);
  const assets = form.getAll("assets");
  if (!assets.length) return setMessage("SELECT AT LEAST ONE ASSET", "error");
  await runCommand({ type: "queue_backtest", revisionId: form.get("revisionId"), assets,
    start: `${form.get("start")}T00:00:00.000Z`, end: `${form.get("end")}T23:59:59.999Z`, initialCapital: Number(form.get("initialCapital")) }, "BACKTEST QUEUED");
}

async function assignmentAction(event) {
  const button = event.target.closest("button[data-assignment-action]");
  if (!button) return;
  const assignment = state.assignments.find((item) => item.id === button.dataset.assignmentId);
  if (!assignment) return;
  if (button.dataset.assignmentAction === "enable") {
    await runCommand({ type: "set_assignment_state", assignmentId: assignment.id, state: "warming" }, "ASSIGNMENT ENABLED");
    return;
  }
  const hasPosition = state.positions.some((position) => position.assignment_id === assignment.id);
  if (!hasPosition) return runCommand({ type: "set_assignment_state", assignmentId: assignment.id, state: "paused" }, "ASSIGNMENT PAUSED");
  state.pauseAssignmentId = assignment.id;
  if (!elements.pauseDialog.open) elements.pauseDialog.showModal();
}

async function pauseChoice(event) {
  const button = event.target.closest("button[data-strats-pause-mode]");
  if (!button || !state.pauseAssignmentId) return;
  elements.pauseDialog.close();
  await runCommand({ type: "set_assignment_state", assignmentId: state.pauseAssignmentId, state: "paused", pauseMode: button.dataset.stratsPauseMode }, "PAUSE REQUESTED");
  state.pauseAssignmentId = null;
}

async function runCommand(command, success) {
  if (!state.user || state.pending) return;
  state.pending = true; render(); setMessage();
  try { await invoke(command); setMessage(success, "success"); await load(); }
  catch (error) { setMessage(String(error?.message ?? error).toUpperCase(), "error"); }
  finally { state.pending = false; render(); }
}

function render() {
  const enabled = Boolean(state.user && !state.pending && APP_CONFIG.strategyCommandsEnabled);
  [...elements.definitionForm.elements, ...elements.assignmentForm.elements, ...elements.backtestForm.elements].forEach((control) => { control.disabled = !enabled; });
  assetPicker.setDisabled(!enabled);
  elements.status.textContent = !state.user ? "SIGN IN TO LOAD" : APP_CONFIG.strategyExecutionEnabled ? "LIVE PAPER ENTRIES" : "SHADOW · ENTRIES OFF";
  elements.definition.innerHTML = state.definitions.length ? state.definitions.map((definition) => `<option value="${escapeStrategyHtml(definition.id)}">${escapeStrategyHtml(definition.name)}</option>`).join("") : '<option value="">NO STRATEGY</option>';
  elements.account.innerHTML = state.accounts.length ? state.accounts.map((account) => `<option value="${escapeStrategyHtml(account.id)}">${escapeStrategyHtml(account.name)}</option>`).join("") : '<option value="">NO ACCOUNT</option>';
  const definitionById = new Map(state.definitions.map((definition) => [definition.id, definition]));
  elements.revision.innerHTML = state.revisions.length ? state.revisions.map((revision) => `<option value="${escapeStrategyHtml(revision.id)}">${escapeStrategyHtml(definitionById.get(revision.definition_id)?.name ?? "STRATEGY")} · R${revision.revision_number}</option>`).join("") : '<option value="">NO REVISION</option>';
  const accountById = new Map(state.accounts.map((account) => [account.id, account]));
  const revisionById = new Map(state.revisions.map((revision) => [revision.id, revision]));
  const latestEvaluation = new Map();
  state.evaluations.forEach((evaluation) => { if (!latestEvaluation.has(evaluation.assignment_id)) latestEvaluation.set(evaluation.assignment_id, evaluation); });
  elements.assignments.innerHTML = state.assignments.length ? table(["STRATEGY","ACCOUNT","ASSET","ALLOCATION","STATE","5M RATIO","1H RATIO","DECISION","RETURN", ""], state.assignments.map((assignment) => {
    const revision = revisionById.get(assignment.revision_id); const definition = definitionById.get(revision?.definition_id); const evaluation = latestEvaluation.get(assignment.id);
    const active = assignment.state !== "paused";
    return [definition?.name ?? "—", accountById.get(assignment.account_id)?.name ?? "ARCHIVED", displayStrategyAsset(assignment.asset), `${Number(assignment.margin_allocation_pct)}%`, strategyStateLabel(assignment),
      ratio(evaluation?.five_minute_values?.ratio), ratio(evaluation?.one_hour_values?.ratio), evaluation?.decision?.replaceAll("_", " ").toUpperCase() ?? "—", percent(assignment.last_net_return),
      `<button type="button" data-assignment-action="${active ? "pause" : "enable"}" data-assignment-id="${escapeStrategyHtml(assignment.id)}">${active ? "PAUSE" : "ENABLE"}</button>`];
  })) : '<p class="hint">NONE</p>';
  elements.backtests.innerHTML = state.runs.length ? table(["CREATED","ASSETS","REQUESTED","ACTUAL","STATUS","FIDELITY","PORTFOLIO"], state.runs.map((run) => [
    new Date(run.created_at).toLocaleString(), run.assets.map(displayStrategyAsset).join(" / "), dateRange(run.requested_start, run.requested_end), dateRange(run.actual_start, run.actual_end),
    run.failure_reason ? `${summarizeBacktest(run)} · ${run.failure_reason}` : summarizeBacktest(run), run.fidelity?.execution?.toUpperCase() ?? "BAR CONSERVATIVE",
    run.metrics?.portfolio ? `${run.metrics.portfolio.tradeCount} TRADES · ${money(run.metrics.portfolio.netPnl)} · DD ${percent(run.metrics.portfolio.maxDrawdown)}` : "—",
  ])) : '<p class="hint">NONE</p>';
}

function table(headers, rows) {
  return `<table class="paper-table strats-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeCell(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function escapeCell(cell) { return String(cell).startsWith("<button") ? cell : escapeStrategyHtml(cell); }
function ratio(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "—"; }
function percent(value) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${(Number(value) * 100).toFixed(2)}%` : "—"; }
function dateRange(start, end) { return start && end ? `${new Date(start).toLocaleDateString()} – ${new Date(end).toLocaleDateString()}` : "—"; }
function setMessage(text = "", tone = "") { elements.message.textContent = text; if (tone) elements.message.dataset.tone = tone; else delete elements.message.dataset.tone; }
