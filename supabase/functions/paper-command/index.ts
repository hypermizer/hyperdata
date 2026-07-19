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

function dependencies(): PaperCommandDependencies {
  const supabaseUrl = required("SUPABASE_URL");
  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const service = createServiceClient(supabaseUrl, serviceRoleKey);
  const epochId = async (accountId: string, epochNumber: number) => {
    const { data, error } = await service.from("paper_account_epochs").select("id")
      .eq("account_id", accountId).eq("epoch_number", epochNumber).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.id as string | undefined;
  };
  return {
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
      const [{ data: summary, error: summaryError }, { data: position, error: positionError }] = await Promise.all([
        service.from("paper_account_summaries").select("cash_balance,withdrawable").eq("epoch_id", epoch.id).single(),
        service.from("paper_positions").select("signed_size,entry_price").eq("epoch_id", epoch.id).eq("asset", asset).maybeSingle(),
      ]);
      if (summaryError) throw new Error(summaryError.message);
      if (positionError) throw new Error(positionError.message);
      return {
        epochNumber: epoch.epoch_number,
        version: Number(epoch.version),
        cashBalance: String(summary.cash_balance),
        availableMargin: String(summary.withdrawable),
        position: position ? { signedSize: String(position.signed_size), entryPrice: String(position.entry_price) } : null,
      };
    },
    async findCommand(accountId, epochNumber, idempotencyKey) {
      const id = await epochId(accountId, epochNumber);
      if (!id) return null;
      const { data, error } = await service.from("paper_commands").select("canonical_result")
        .eq("epoch_id", id).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (error) throw new Error(error.message);
      return data?.canonical_result ?? null;
    },
    async loadAsset(asset) {
      const catalog = await fetchPaperCatalog();
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
      if (error) throw new Error(error.message);
      return data;
    },
    now: Date.now,
  };
}

export async function servePaperCommand(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const response = await handlePaperCommand(request, dependencies());
    const headers = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return Response.json(
      { error: "paper_command_failed", detail: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
}

if (import.meta.main) Deno.serve(servePaperCommand);
