import { createClient } from "@supabase/supabase-js";
import { createServiceClient } from "../_shared/database.ts";
import { fetchMarketBatches } from "../_shared/hyperliquid.ts";
import {
  fetchPaperBook,
  fetchPaperCatalog,
  fetchPaperFeeSchedule,
  inputVersion,
} from "../_shared/paper/market-data.ts";
import { handlePaperCommand, type PaperCommandDependencies } from "./handler.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
import { makerFraction } from "../_shared/paper/fees.ts";
import { initialMargin } from "../_shared/paper/margin.ts";

type CommandPosition = {
  asset: string;
  margin_mode: "cross" | "isolated";
  signed_size: string | number;
  entry_price: string | number;
  isolated_margin: string | number | null;
};

export function projectCommandPortfolio({
  cashBalance, positions, marks, leverageByAsset, metadataByAsset,
}: {
  cashBalance: string;
  positions: CommandPosition[];
  marks: Map<string, string>;
  leverageByAsset: Map<string, number>;
  metadataByAsset: Map<string, { marginTiers: Parameters<typeof initialMargin>[2] }>;
}) {
  const marginByAsset = new Map<string, ReturnType<typeof decimal>>();
  const totals = positions.reduce((result, position) => {
    const mark = marks.get(position.asset);
    const metadata = metadataByAsset.get(position.asset);
    if (!mark) throw new Error(`portfolio_mark_unavailable:${position.asset}`);
    if (!metadata) throw new Error(`portfolio_state_unavailable:metadata:${position.asset}`);
    const notional = decimal(position.signed_size).abs().times(mark);
    const positionMargin = position.margin_mode === "isolated"
      ? decimal(position.isolated_margin ?? 0)
      : decimal(initialMargin(decimalString(notional), leverageByAsset.get(position.asset) ?? 1, metadata.marginTiers));
    marginByAsset.set(position.asset, positionMargin);
    return {
      unrealized: result.unrealized.plus(decimal(position.signed_size).times(decimal(mark).minus(position.entry_price))),
      margin: result.margin.plus(positionMargin),
    };
  }, { unrealized: decimal(0), margin: decimal(0) });
  return {
    unrealizedPnl: decimalString(totals.unrealized),
    equity: decimalString(decimal(cashBalance).plus(totals.unrealized)),
    marginUsed: decimalString(totals.margin),
    marginByAsset,
  };
}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function createPaperCommandDependencies(): PaperCommandDependencies {
  const supabaseUrl = required("SUPABASE_URL");
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const service = createServiceClient(supabaseUrl, serviceRoleKey);
  let catalogPromise: ReturnType<typeof fetchPaperCatalog> | null = null;
  const loadCatalog = () => catalogPromise ??= fetchPaperCatalog();
  const epochId = async (accountId: string, epochNumber: number) => {
    const { data, error } = await service.from("paper_account_epochs").select("id")
      .eq("account_id", accountId).eq("epoch_number", epochNumber).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.id as string | undefined;
  };
  return {
    enabled: Deno.env.get("PAPER_TRADING_ENABLED") === "true",
    async authenticate(token) {
      const client = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user) return null;
      return { id: data.user.id, email: data.user.email ?? null };
    },
    async loadAccount(accountId, userId, asset) {
      const { data: account, error: accountError } = await service.from("paper_accounts")
        .select("active_epoch").eq("id", accountId).eq("user_id", userId)
        .is("archived_at", null).maybeSingle();
      if (accountError) throw new Error(accountError.message);
      if (!account) return null;
      const { data: epoch, error: epochError } = await service.from("paper_account_epochs")
        .select("id,epoch_number,version").eq("account_id", accountId)
        .eq("epoch_number", account.active_epoch).eq("state", "active").maybeSingle();
      if (epochError) throw new Error(epochError.message);
      if (!epoch) return null;
      const [{ data: summary, error: summaryError }, { data: position, error: positionError }, { data: positions, error: positionsError }, { data: settings, error: settingsError }, { data: orders, error: ordersError }, { data: feeVolume, error: feeVolumeError }, catalog] = await Promise.all([
        service.from("paper_account_summaries").select("cash_balance").eq("epoch_id", epoch.id).single(),
        service.from("paper_positions").select("signed_size,entry_price").eq("epoch_id", epoch.id).eq("asset", asset).maybeSingle(),
        service.from("paper_positions").select("asset,margin_mode,signed_size,entry_price,isolated_margin").eq("epoch_id", epoch.id),
        service.from("paper_leverage_settings").select("asset,leverage").eq("epoch_id", epoch.id),
        service.from("paper_orders").select("reserved_margin").eq("epoch_id", epoch.id)
          .in("status", ["resting", "partially_filled", "trigger_waiting"]),
        service.rpc("paper_fee_volume", { p_epoch_id: epoch.id }).single(),
        loadCatalog(),
      ]);
      if (summaryError) throw new Error(summaryError.message);
      if (positionError) throw new Error(positionError.message);
      if (positionsError || settingsError || ordersError || feeVolumeError) throw new Error(positionsError?.message ?? settingsError?.message ?? ordersError?.message ?? feeVolumeError?.message);
      const leverageByAsset = new Map((settings ?? []).map((setting) => [setting.asset, Number(setting.leverage)]));
      const metadataByAsset = new Map(catalog.assets.map((item) => [item.asset, item]));
      const requests = [...new Set((positions ?? []).map((item) => item.asset))]
        .map((positionAsset) => ({ asset: positionAsset, dex: positionAsset.includes(":") ? positionAsset.split(":", 1)[0] : "" }));
      const liveMarks = new Map<string, string>();
      if (requests.length) {
        const batches = await fetchMarketBatches(requests, new Date());
        for (const result of batches.values()) {
          if (!result.ok) throw new Error(`portfolio_mark_unavailable:${result.error}`);
          for (const observation of result.observations) liveMarks.set(observation.asset, String(observation.mark_price));
        }
      }
      const projection = projectCommandPortfolio({
        cashBalance: String(summary.cash_balance), positions: positions ?? [],
        marks: liveMarks, leverageByAsset, metadataByAsset,
      });
      const reservedMargin = (orders ?? []).reduce((total, order) => total.plus(order.reserved_margin), decimal(0));
      const availableMargin = decimal(projection.equity).minus(projection.marginUsed).minus(reservedMargin);
      const feeTotals = feeVolume as { trailing_volume: unknown; maker_volume: unknown };
      const rollingVolume = {
        trailingVolume: String(feeTotals.trailing_volume), makerVolume: String(feeTotals.maker_volume),
      };
      return {
        epochNumber: epoch.epoch_number,
        version: Number(epoch.version),
        cashBalance: String(summary.cash_balance),
        availableMargin: decimalString(availableMargin),
        currentMargin: decimalString(projection.marginByAsset.get(asset) ?? decimal(0)),
        trailingVolume: rollingVolume.trailingVolume,
        makerFraction: makerFraction(rollingVolume.makerVolume, rollingVolume.trailingVolume),
        position: position ? { signedSize: String(position.signed_size), entryPrice: String(position.entry_price) } : null,
      };
    },
    async findCommand(accountId, epochNumber, idempotencyKey, userId) {
      const { data: owned, error: ownershipError } = await service.from("paper_accounts").select("id")
        .eq("id", accountId).eq("user_id", userId).is("archived_at", null).maybeSingle();
      if (ownershipError) throw new Error(ownershipError.message);
      if (!owned) return null;
      const id = await epochId(accountId, epochNumber);
      if (!id) return null;
      const { data, error } = await service.from("paper_commands").select("canonical_result")
        .eq("epoch_id", id).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.canonical_result ?? null;
    },
    async loadAsset(asset) {
      const catalog = await loadCatalog();
      return catalog.assets.find((item) => item.asset === asset) ?? null;
    },
    async loadMark(asset, dex) {
      const results = await fetchMarketBatches([{ asset, dex }], new Date());
      const result = results.get(dex);
      if (!result?.ok || result.observations.length !== 1) throw new Error("mark unavailable");
      const observation = result.observations[0];
      return {
        markPrice: String(observation.mark_price),
        inputVersion: await inputVersion(observation),
      };
    },
    loadBook: fetchPaperBook,
    loadFeeSchedule: fetchPaperFeeSchedule,
    async applyEffects(effects, context) {
      const { data, error } = await service.rpc("apply_paper_effects", {
        p_account_id: context.accountId,
        p_epoch_number: context.epochNumber,
        p_expected_version: context.expectedVersion,
        p_idempotency_key: context.idempotencyKey,
        p_effects: effects,
      });
      if (error) throw error;
      return data;
    },
    now: Date.now,
  };
}

export function paperCommandFailureResponse(error: unknown): Response {
  const failure = error as { code?: unknown; message?: unknown };
  const message = typeof failure?.message === "string" ? failure.message : String(error);
  if (failure?.code === "40001" || message === "stale paper account version") {
    return Response.json({ error: "stale_account" }, { status: 409, headers: corsHeaders });
  }
  if (message.startsWith("portfolio_mark_unavailable:")) {
    return Response.json({ error: "portfolio_mark_unavailable" }, { status: 503, headers: corsHeaders });
  }
  if (message.startsWith("portfolio_state_unavailable:")) {
    return Response.json({ error: "portfolio_state_unavailable" }, { status: 503, headers: corsHeaders });
  }
  return Response.json(
    { error: "paper_command_failed", detail: message },
    { status: 500, headers: corsHeaders },
  );
}

export async function servePaperCommand(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const response = await handlePaperCommand(request, createPaperCommandDependencies());
    const headers = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return paperCommandFailureResponse(error);
  }
}

if (import.meta.main) Deno.serve(servePaperCommand);
