import { applyFill } from "../_shared/paper/accounting.ts";
import { validateOrderConstraints } from "../_shared/paper/constraints.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
import { executeOrder, validTriggerSide } from "../_shared/paper/execution.ts";
import { selectFeeRate } from "../_shared/paper/fees.ts";
import { initialMargin } from "../_shared/paper/margin.ts";
import type { NormalizedBook } from "../_shared/paper/market-data.ts";
import type { FeeSchedule, PaperAssetMetadata, PaperPosition } from "../_shared/paper/types.ts";

const OWNER_EMAIL = "jasonblick@zohomail.com";
const MAX_BOOK_AGE_MS = 10_000;

export interface PaperCommandUser { id: string; email: string | null }
export interface PaperAccountState {
  epochNumber: number;
  version: number;
  cashBalance: string;
  availableMargin: string;
  currentMargin: string;
  position: PaperPosition | null;
}
export interface ApplyContext {
  accountId: string;
  epochNumber: number;
  expectedVersion: number;
  idempotencyKey: string;
}
export interface PaperCommandDependencies {
  enabled: boolean;
  authenticate(token: string): Promise<PaperCommandUser | null>;
  loadAccount(accountId: string, userId: string, asset: string): Promise<PaperAccountState | null>;
  findCommand(accountId: string, epochNumber: number, idempotencyKey: string): Promise<unknown | null>;
  loadAsset(asset: string): Promise<PaperAssetMetadata | null>;
  loadMark(asset: string, dex: string): Promise<{ markPrice: string; inputVersion: string }>;
  loadBook(asset: string): Promise<{ book: NormalizedBook; inputVersion: string }>;
  loadFeeSchedule(): Promise<{ schedule: FeeSchedule; inputVersion: string }>;
  applyEffects(effects: Record<string, unknown>, context: ApplyContext): Promise<unknown>;
  now(): number;
}

interface PlaceOrderCommand {
  type: "place_order";
  accountId: string;
  epochNumber: number;
  expectedVersion: number;
  idempotencyKey: string;
  order: {
    asset: string;
    side: "buy" | "sell";
    size: string;
    orderType: "market" | "limit" | "stop_market" | "stop_limit" | "take_market" | "take_limit";
    timeInForce: "GTC" | "ALO" | "IOC" | null;
    limitPrice: string | null;
    triggerPrice?: string | null;
    leverage: number;
    marginMode: "cross" | "isolated";
    reduceOnly: boolean;
  };
}

function jsonError(error: string, status: number, details?: unknown): Response {
  return Response.json(details === undefined ? { error } : { error, details }, { status });
}

function parseCommand(value: unknown): PlaceOrderCommand | null {
  if (!value || typeof value !== "object") return null;
  const command = value as Partial<PlaceOrderCommand>;
  const order = command.order as Partial<PlaceOrderCommand["order"]> | undefined;
  const limitRequired = order && ["limit", "stop_limit", "take_limit"].includes(String(order.orderType));
  if (command.type !== "place_order" || typeof command.accountId !== "string" ||
    !Number.isInteger(command.epochNumber) || !Number.isInteger(command.expectedVersion) ||
    typeof command.idempotencyKey !== "string" || !order || typeof order.asset !== "string" ||
    !["buy", "sell"].includes(String(order.side)) || typeof order.size !== "string" ||
    !["market", "limit", "stop_market", "stop_limit", "take_market", "take_limit"].includes(String(order.orderType)) ||
    (order.timeInForce !== null && !["GTC", "ALO", "IOC"].includes(String(order.timeInForce))) ||
    (order.limitPrice !== null && typeof order.limitPrice !== "string") ||
    (limitRequired && typeof order.limitPrice !== "string") ||
    (order.triggerPrice !== undefined && order.triggerPrice !== null && typeof order.triggerPrice !== "string") ||
    !Number.isInteger(order.leverage) || !["cross", "isolated"].includes(String(order.marginMode)) ||
    typeof order.reduceOnly !== "boolean") return null;
  return value as PlaceOrderCommand;
}

export async function handlePaperCommand(
  request: Request,
  dependencies: PaperCommandDependencies,
): Promise<Response> {
  if (request.method !== "POST") return jsonError("method_not_allowed", 405);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return jsonError("unauthorized", 401);
  const user = await dependencies.authenticate(authorization.slice(7));
  if (!user || user.email?.toLowerCase() !== OWNER_EMAIL) return jsonError("unauthorized", 401);
  if (!dependencies.enabled) return jsonError("paper_trading_disabled", 503);

  let raw: unknown;
  try { raw = await request.json(); } catch { return jsonError("invalid_json", 400); }
  const command = parseCommand(raw);
  if (!command) return jsonError("invalid_command", 400);

  const account = await dependencies.loadAccount(command.accountId, user.id, command.order.asset);
  if (!account) return jsonError("account_not_found", 404);
  const stored = await dependencies.findCommand(command.accountId, command.epochNumber, command.idempotencyKey);
  if (stored !== null) return Response.json(stored);
  if (account.epochNumber !== command.epochNumber || account.version !== command.expectedVersion) {
    return jsonError("stale_account", 409);
  }

  const asset = await dependencies.loadAsset(command.order.asset);
  if (!asset) return jsonError("unknown_asset", 422);
  if (asset.collateralToken !== 0) return jsonError("unsupported_collateral", 422);

  const triggerKind = command.order.orderType.startsWith("stop_") ? "stop"
    : command.order.orderType.startsWith("take_") ? "take" : null;
  if (triggerKind) {
    if (!command.order.triggerPrice) return jsonError("missing_trigger_price", 422);
    const mark = await dependencies.loadMark(command.order.asset, asset.dex);
    const constraintErrors = validateOrderConstraints(asset, {
      size: command.order.size,
      price: command.order.limitPrice ?? command.order.triggerPrice,
      leverage: command.order.leverage,
      marginMode: command.order.marginMode,
      marketState: "open",
    });
    if (constraintErrors.length) return jsonError("invalid_order", 422, constraintErrors);
    if (!validTriggerSide(command.order.side, triggerKind, command.order.triggerPrice, mark.markPrice)) {
      return jsonError("invalid_trigger_side", 422);
    }
    const effects: Record<string, unknown> = {
      response: {
        status: "trigger_waiting",
        remainingSize: command.order.size,
        reason: null,
        fidelity: "trade_replay",
        sourceTimestamp: new Date(dependencies.now()).toISOString(),
        processedAt: new Date(dependencies.now()).toISOString(),
      },
      order: {
        ...command.order,
        requestedSize: command.order.size,
        remainingSize: command.order.size,
        queueAhead: null,
        status: "trigger_waiting",
      },
      fills: [],
      position: account.position,
      positionProjection: account.position,
      ledger: [],
      inputVersions: { mark: mark.inputVersion },
    };
    const canonical = await dependencies.applyEffects(effects, {
      accountId: command.accountId,
      epochNumber: command.epochNumber,
      expectedVersion: command.expectedVersion,
      idempotencyKey: command.idempotencyKey,
    });
    return Response.json(canonical);
  }

  const { book, inputVersion: bookVersion } = await dependencies.loadBook(command.order.asset);
  if (dependencies.now() - book.timestampMs > MAX_BOOK_AGE_MS) return jsonError("stale_book", 503);
  const referencePrice = command.order.limitPrice ??
    (command.order.side === "buy" ? book.asks[0]?.price : book.bids[0]?.price);
  if (!referencePrice) return jsonError("empty_book", 503);
  const constraintErrors = validateOrderConstraints(asset, {
    size: command.order.size,
    price: referencePrice,
    leverage: command.order.leverage,
    marginMode: command.order.marginMode,
    marketState: "open",
  });
  if (constraintErrors.length) return jsonError("invalid_order", 422, constraintErrors);

  const execution = executeOrder({
    side: command.order.side,
    size: command.order.size,
    type: command.order.orderType as "market" | "limit",
    timeInForce: command.order.timeInForce,
    limitPrice: command.order.limitPrice,
    reduceOnly: command.order.reduceOnly,
  }, book, account.position?.signedSize ?? "0");
  if (execution.status === "rejected") return jsonError(execution.reason ?? "order_rejected", 422);

  const riskFills = [...execution.fills];
  if (["resting", "partially_filled"].includes(execution.status) && decimal(execution.remainingSize).isPositive()) {
    riskFills.push({ price: command.order.limitPrice ?? referencePrice, size: execution.remainingSize });
  }
  let riskPosition = account.position;
  for (const fill of riskFills) {
    riskPosition = applyFill(riskPosition, {
      side: command.order.side, size: fill.size, price: fill.price, feeRate: "0",
    }).position;
  }
  const riskMark = riskFills.at(-1)?.price ?? referencePrice;
  const finalInitialMargin = riskPosition === null ? decimal(0) : decimal(initialMargin(
    decimalString(decimal(riskPosition.signedSize).abs().times(riskMark)),
    command.order.leverage,
    asset.marginTiers,
  ));
  const marginCapacity = decimal(account.availableMargin).plus(account.currentMargin);
  if (finalInitialMargin.gt(marginCapacity)) {
    return jsonError("insufficient_margin", 422);
  }

  const feeInput = await dependencies.loadFeeSchedule();
  const feeRate = selectFeeRate(feeInput.schedule, "0", "0", "taker");
  let position = account.position;
  let totalFee = decimal(0);
  let totalRealized = decimal(0);
  const fills = execution.fills.map((fill, index) => {
    const transition = applyFill(position, {
      side: command.order.side,
      size: fill.size,
      price: fill.price,
      feeRate,
    });
    position = transition.position;
    totalFee = totalFee.plus(transition.fee);
    totalRealized = totalRealized.plus(transition.realizedPnl);
    return {
      ...fill,
      fee: transition.fee,
      liquidity: "taker",
      sourceId: `${command.idempotencyKey}:${bookVersion}:${index}`,
    };
  });
  const sourceTimestamp = new Date(book.timestampMs).toISOString();
  const ledger: Array<Record<string, string>> = [];
  if (!totalRealized.isZero()) ledger.push({
    entry_type: "realized_pnl",
    amount: decimalString(totalRealized),
    asset: command.order.asset,
    source_timestamp: sourceTimestamp,
  });
  if (!totalFee.isZero()) ledger.push({
    entry_type: "fee",
    amount: decimalString(totalFee.negated()),
    asset: command.order.asset,
    source_timestamp: sourceTimestamp,
  });

  const effects: Record<string, unknown> = {
    response: {
      status: execution.status,
      remainingSize: execution.remainingSize,
      reason: execution.reason,
      fidelity: execution.fills.length ? "exact_book" : "estimated_queue",
      sourceTimestamp,
      processedAt: new Date(dependencies.now()).toISOString(),
    },
    order: {
      ...command.order,
      requestedSize: execution.requestedSize,
      remainingSize: execution.remainingSize,
      queueAhead: execution.queueAhead,
      status: execution.status,
    },
    fills,
    position,
    positionProjection: position === null ? null : {
      asset: command.order.asset,
      marginMode: command.order.marginMode,
      signedSize: position.signedSize,
      entryPrice: position.entryPrice,
      markPrice: execution.fills.at(-1)?.price ?? referencePrice,
      leverage: command.order.leverage,
      inputVersion: bookVersion,
    },
    ledger,
    inputVersions: { book: bookVersion, fees: feeInput.inputVersion },
  };
  const canonical = await dependencies.applyEffects(effects, {
    accountId: command.accountId,
    epochNumber: command.epochNumber,
    expectedVersion: command.expectedVersion,
    idempotencyKey: command.idempotencyKey,
  });
  return Response.json(canonical);
}
