import { createServiceClient } from "../_shared/database.ts";
import { fetchMarketBatches } from "../_shared/hyperliquid.ts";
import { inputVersion } from "../_shared/paper/market-data.ts";
import { reconcileAccount } from "../_shared/paper/reconciliation.ts";
import { handleProcessPaper, type ProcessPaperDependencies } from "./handler.ts";
import { processPaperBatch, type PaperProcessorDependencies, type ProcessorSnapshot } from "./processor.ts";

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function runtimeDependencies(): ProcessPaperDependencies {
  const service = createServiceClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  const processor: PaperProcessorDependencies = {
    async loadWork() {
      const [{ data: positions, error: positionError }, { data: orders, error: orderError }] = await Promise.all([
        service.from("paper_positions").select("epoch_id,asset"),
        service.from("paper_orders").select("epoch_id,asset").in("status", ["resting", "partially_filled", "trigger_waiting"]),
      ]);
      if (positionError || orderError) throw new Error(positionError?.message ?? orderError?.message);
      const byAsset = new Map<string, { hasPosition: boolean; accountIds: Set<string> }>();
      for (const row of positions ?? []) {
        const entry = byAsset.get(row.asset) ?? { hasPosition: false, accountIds: new Set<string>() };
        entry.hasPosition = true; entry.accountIds.add(row.epoch_id); byAsset.set(row.asset, entry);
      }
      for (const row of orders ?? []) {
        const entry = byAsset.get(row.asset) ?? { hasPosition: false, accountIds: new Set<string>() };
        entry.accountIds.add(row.epoch_id); byAsset.set(row.asset, entry);
      }
      return [...byAsset].map(([asset, entry]) => ({
        asset, hasPosition: entry.hasPosition, accountIds: [...entry.accountIds],
      }));
    },
    async fetchSnapshot(asset) {
      const dex = asset.includes(":") ? asset.split(":", 1)[0] : "";
      const results = await fetchMarketBatches([{ asset, dex }], new Date());
      const result = results.get(dex);
      if (!result?.ok || result.observations.length !== 1) {
        throw new Error(result && !result.ok ? result.error : "mark_unavailable");
      }
      const observation = result.observations[0];
      return {
        asset, inputVersion: await inputVersion(observation), apiWeight: 20,
        degraded: false, payload: { markPrice: String(observation.mark_price), observation },
      };
    },
    async processAccount(epochId, snapshot: ProcessorSnapshot) {
      const [{ data: epoch, error: epochError }, { data: summary, error: summaryError }, { data: positions, error: positionsError }] = await Promise.all([
        service.from("paper_account_epochs").select("version").eq("id", epochId).eq("state", "active").maybeSingle(),
        service.from("paper_account_summaries").select("cash_balance,equity").eq("epoch_id", epochId).maybeSingle(),
        service.from("paper_positions").select("signed_size,entry_price,mark_price,isolated_margin").eq("epoch_id", epochId),
      ]);
      if (epochError || summaryError || positionsError) throw new Error(epochError?.message ?? summaryError?.message ?? positionsError?.message);
      if (!epoch || !summary) return { mutated: false };
      const reconciled = reconcileAccount({
        cashBalance: String(summary.cash_balance), cachedEquity: String(summary.equity),
        positions: (positions ?? []).map((position) => ({
          signedSize: String(position.signed_size), entryPrice: String(position.entry_price),
          markPrice: String(position.mark_price), isolatedMargin: position.isolated_margin === null ? null : String(position.isolated_margin),
        })),
      });
      if (!reconciled.reconciled) return { mutated: false, reconciliationFailure: true };
      const payload = snapshot.payload as { markPrice: string; observation: unknown };
      const { error: inputError } = await service.from("paper_market_inputs").upsert({
        asset: snapshot.asset, input_kind: "context", input_version: snapshot.inputVersion,
        source_timestamp: new Date().toISOString(), payload: payload.observation, fidelity: "live",
      }, { onConflict: "asset,input_kind,input_version", ignoreDuplicates: true });
      if (inputError) throw new Error(inputError.message);
      const { data, error } = await service.rpc("revalue_paper_epoch_asset", {
        p_epoch_id: epochId, p_expected_version: epoch.version, p_asset: snapshot.asset,
        p_mark_price: payload.markPrice, p_input_version: snapshot.inputVersion,
      });
      if (error) throw new Error(error.message);
      return { mutated: data === true };
    },
  };
  return {
    enabled: Deno.env.get("PAPER_TRADING_ENABLED") === "true",
    schedulerSecret: required("PAPER_SCHEDULER_SECRET"),
    async claim(bucket) {
      const { data, error } = await service.rpc("claim_paper_processor_bucket", { p_bucket: bucket });
      if (error) throw new Error(error.message);
      return data === true;
    },
    process: () => processPaperBatch(processor, 500),
    async finish(bucket, state, metrics) {
      const { error } = await service.rpc("finish_paper_processor_bucket", {
        p_bucket: bucket, p_state: state, p_metrics: metrics,
      });
      if (error) throw new Error(error.message);
    },
    now: Date.now,
  };
}

export async function serveProcessPaper(request: Request): Promise<Response> {
  try { return await handleProcessPaper(request, runtimeDependencies()); }
  catch (error) {
    return Response.json({ error: "paper_processor_configuration", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

if (import.meta.main) Deno.serve(serveProcessPaper);
