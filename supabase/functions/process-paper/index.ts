import { createServiceClient } from "../_shared/database.ts";
import { fetchMarketBatches } from "../_shared/hyperliquid.ts";
import { inputVersion } from "../_shared/paper/market-data.ts";
import { fetchPaperBook, fetchPaperCatalog, fetchPaperFeeSchedule, fetchPaperFunding, fetchPaperTrades } from "../_shared/paper/market-data.ts";
import { selectFeeRate } from "../_shared/paper/fees.ts";
import { crossRisk, isolatedRisk, maintenanceMargin } from "../_shared/paper/margin.ts";
import { unrealizedPnl } from "../_shared/paper/accounting.ts";
import { reconcileAccount } from "../_shared/paper/reconciliation.ts";
import { decimal, decimalString } from "../_shared/paper/decimal.ts";
import { replayOrder, type ReplaySnapshot } from "./account-processor.ts";
import { missingFundingEffects } from "./funding.ts";
import { buildLiquidationEffect } from "./liquidation.ts";
import { handleProcessPaper, type ProcessPaperDependencies } from "./handler.ts";
import { processPaperBatch, type PaperProcessorDependencies, type ProcessorSnapshot } from "./processor.ts";

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function runtimeDependencies(): ProcessPaperDependencies {
  const service = createServiceClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  let catalogPromise: ReturnType<typeof fetchPaperCatalog> | null = null;
  let feePromise: ReturnType<typeof fetchPaperFeeSchedule> | null = null;
  const processor: PaperProcessorDependencies = {
    estimateSnapshotWeight: () => 142,
    async loadWork() {
      const { data: accounts, error: accountError } = await service.from("paper_accounts")
        .select("id,active_epoch").is("archived_at", null);
      if (accountError) throw new Error(accountError.message);
      if (!accounts?.length) return [];
      const { data: epochs, error: epochError } = await service.from("paper_account_epochs")
        .select("id,account_id,epoch_number").eq("state", "active").in("account_id", accounts.map((account) => account.id));
      if (epochError) throw new Error(epochError.message);
      const activeByAccount = new Map(accounts.map((account) => [account.id, account.active_epoch]));
      const epochIds = (epochs ?? []).filter((epoch) => activeByAccount.get(epoch.account_id) === epoch.epoch_number).map((epoch) => epoch.id);
      if (!epochIds.length) return [];
      const [{ data: positions, error: positionError }, { data: orders, error: orderError }] = await Promise.all([
        service.from("paper_positions").select("epoch_id,asset").in("epoch_id", epochIds),
        service.from("paper_orders").select("epoch_id,asset").in("epoch_id", epochIds).in("status", ["resting", "partially_filled", "trigger_waiting"]),
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
      const { data: priorInput, error: priorError } = await service.from("paper_market_inputs")
        .select("payload").eq("asset", asset).eq("input_kind", "trades")
        .order("source_timestamp", { ascending: false }).limit(1).maybeSingle();
      if (priorError) throw new Error(priorError.message);
      const cursor = (priorInput?.payload as { cursor?: { lastTradeId: string | null; lastTimestampMs: number | null } } | null)?.cursor ??
        { lastTradeId: null, lastTimestampMs: null };
      const { data: cachedFunding, error: fundingCacheError } = await service.from("paper_market_inputs")
        .select("payload,input_version,created_at").eq("asset", asset).eq("input_kind", "funding")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (fundingCacheError) throw new Error(fundingCacheError.message);
      const fundingIsFresh = cachedFunding && Date.now() - Date.parse(cachedFunding.created_at) < 55_000;
      const fundingPromise = fundingIsFresh
        ? Promise.resolve({ points: (cachedFunding.payload as { points?: never[] }).points ?? [], inputVersion: cachedFunding.input_version, fetched: false })
        : fetchPaperFunding(asset, Date.now() - 24 * 60 * 60 * 1_000, Date.now()).then((value) => ({ ...value, fetched: true }));
      catalogPromise ??= fetchPaperCatalog();
      feePromise ??= fetchPaperFeeSchedule();
      const [results, bookInput, tradeInput, feeInput, fundingInput, catalogInput] = await Promise.all([
        fetchMarketBatches([{ asset, dex }], new Date()),
        fetchPaperBook(asset), fetchPaperTrades(asset, cursor), feePromise, fundingPromise, catalogPromise,
      ]);
      const result = results.get(dex);
      if (!result?.ok || result.observations.length !== 1) {
        throw new Error(result && !result.ok ? result.error : "mark_unavailable");
      }
      const observation = result.observations[0];
      const metadata = catalogInput.assets.find((item) => item.asset === asset);
      if (!metadata) throw new Error("asset_metadata_unavailable");
      const version = await inputVersion({
        context: observation, book: bookInput.inputVersion,
        trades: tradeInput.inputVersion, fees: feeInput.inputVersion, funding: fundingInput.inputVersion,
      });
      return {
        asset, inputVersion: version, apiWeight: 122 + (fundingInput.fetched ? 20 : 0),
        degraded: tradeInput.gap, payload: {
          markPrice: String(observation.mark_price), observation,
          book: bookInput.book, trades: tradeInput.trades, tradeGap: tradeInput.gap,
          cursor: tradeInput.cursor, bookVersion: bookInput.inputVersion,
          tradeVersion: tradeInput.inputVersion,
          fundingPoints: fundingInput.points, fundingVersion: fundingInput.inputVersion,
          metadata, catalog: catalogInput.assets,
          feeRates: {
            maker: selectFeeRate(feeInput.schedule, "0", "0", "maker"),
            taker: selectFeeRate(feeInput.schedule, "0", "0", "taker"),
          },
        },
      };
    },
    async processAccount(epochId, snapshot: ProcessorSnapshot) {
      const [{ data: epoch, error: epochError }, { data: summary, error: summaryError }, { data: positions, error: positionsError }, { data: orders, error: ordersError }, { data: fills, error: fillsError }, { data: fundingPayments, error: fundingError }] = await Promise.all([
        service.from("paper_account_epochs").select("version").eq("id", epochId).eq("state", "active").maybeSingle(),
        service.from("paper_account_summaries").select("cash_balance,equity").eq("epoch_id", epochId).maybeSingle(),
        service.from("paper_positions").select("asset,margin_mode,signed_size,entry_price,mark_price,isolated_margin").eq("epoch_id", epochId),
        service.from("paper_orders").select("id,side,order_type,status,remaining_size,limit_price,trigger_price,queue_ahead,reduce_only,created_at")
          .eq("epoch_id", epochId).eq("asset", snapshot.asset).in("status", ["resting", "partially_filled", "trigger_waiting"])
          .order("created_at", { ascending: true }),
        service.from("paper_fills").select("side,size,price,source_timestamp").eq("epoch_id", epochId).eq("asset", snapshot.asset),
        service.from("paper_funding_payments").select("funding_timestamp").eq("epoch_id", epochId).eq("asset", snapshot.asset),
      ]);
      if (epochError || summaryError || positionsError || ordersError || fillsError || fundingError) throw new Error(epochError?.message ?? summaryError?.message ?? positionsError?.message ?? ordersError?.message ?? fillsError?.message ?? fundingError?.message);
      if (!epoch || !summary) return { mutated: false };
      const reconciled = reconcileAccount({
        cashBalance: String(summary.cash_balance), cachedEquity: String(summary.equity),
        positions: (positions ?? []).map((position) => ({
          signedSize: String(position.signed_size), entryPrice: String(position.entry_price),
          markPrice: String(position.mark_price), isolatedMargin: position.isolated_margin === null ? null : String(position.isolated_margin),
        })),
      });
      if (!reconciled.reconciled) return { mutated: false, reconciliationFailure: true };
      const payload = snapshot.payload as {
        markPrice: string; observation: unknown; book: ReplaySnapshot["book"];
        trades: ReplaySnapshot["trades"]; tradeGap: boolean;
        cursor: unknown; bookVersion: string; tradeVersion: string;
        fundingPoints: Parameters<typeof missingFundingEffects>[0]; fundingVersion: string;
        feeRates: { maker: string; taker: string };
        metadata: Awaited<ReturnType<typeof fetchPaperCatalog>>["assets"][number];
        catalog: Awaited<ReturnType<typeof fetchPaperCatalog>>["assets"];
      };
      const inputRows = [
        { input_kind: "context", input_version: snapshot.inputVersion, payload: payload.observation, gap_state: null },
        { input_kind: "book", input_version: payload.bookVersion, payload: payload.book, gap_state: null },
        { input_kind: "trades", input_version: payload.tradeVersion, payload: { cursor: payload.cursor, trades: payload.trades }, gap_state: payload.tradeGap ? "gap" : null },
        { input_kind: "funding", input_version: payload.fundingVersion, payload: { points: payload.fundingPoints }, gap_state: null },
      ].map((row) => ({ asset: snapshot.asset, source_timestamp: new Date().toISOString(), fidelity: row.gap_state ? "degraded" : "live", ...row }));
      const { error: inputError } = await service.from("paper_market_inputs").upsert(inputRows, {
        onConflict: "asset,input_kind,input_version", ignoreDuplicates: true,
      });
      if (inputError) throw new Error(inputError.message);

      let expectedVersion = Number(epoch.version);
      const storedPosition = (positions ?? []).find((position) => position.asset === snapshot.asset);
      let position = storedPosition ? {
        signedSize: String(storedPosition.signed_size), entryPrice: String(storedPosition.entry_price),
      } : null;
      const replaySnapshot: ReplaySnapshot = {
        markPrice: payload.markPrice, book: payload.book, trades: payload.trades,
        tradeGap: payload.tradeGap, inputVersion: snapshot.inputVersion,
      };
      for (const order of orders ?? []) {
        const effect = replayOrder({
          id: order.id, side: order.side, orderType: order.order_type,
          status: order.status, remainingSize: String(order.remaining_size),
          limitPrice: order.limit_price === null ? null : String(order.limit_price),
          triggerPrice: order.trigger_price === null ? null : String(order.trigger_price),
          queueAhead: order.queue_ahead === null ? null : String(order.queue_ahead),
          reduceOnly: order.reduce_only, createdAtMs: Date.parse(order.created_at),
        }, position, replaySnapshot, payload.feeRates);
        if (!effect) continue;
        const { data: applied, error: replayError } = await service.rpc("apply_paper_replay_effect", {
          p_epoch_id: epochId, p_expected_version: expectedVersion,
          p_effects: {
            ...effect, markPrice: payload.markPrice, inputVersion: snapshot.inputVersion,
            sourceTimestamp: new Date(payload.book.timestampMs).toISOString(),
          },
        });
        if (replayError) throw new Error(replayError.message);
        if (!applied) return { mutated: false };
        expectedVersion += 1;
        position = effect.position;
      }
      const fundingEffects = missingFundingEffects(
        payload.fundingPoints,
        (fills ?? []).map((fill) => ({
          side: fill.side, size: String(fill.size), price: String(fill.price),
          timestampMs: Date.parse(fill.source_timestamp),
        })),
        new Set((fundingPayments ?? []).map((payment) => Date.parse(payment.funding_timestamp))),
        String((payload.observation as { oracle_price?: number | null }).oracle_price ?? payload.markPrice),
        payload.fundingVersion,
      );
      for (const effect of fundingEffects) {
        const { data: applied, error: fundingApplyError } = await service.rpc("apply_paper_funding_effect", {
          p_epoch_id: epochId, p_expected_version: expectedVersion,
          p_asset: snapshot.asset, p_effect: effect,
        });
        if (fundingApplyError) throw new Error(fundingApplyError.message);
        if (!applied) return { mutated: false };
        expectedVersion += 1;
      }
      const { data, error } = await service.rpc("revalue_paper_epoch_asset", {
        p_epoch_id: epochId, p_expected_version: expectedVersion, p_asset: snapshot.asset,
        p_mark_price: payload.markPrice, p_input_version: snapshot.inputVersion,
      });
      if (error) throw new Error(error.message);
      if (!data) return { mutated: false };
      if (position) expectedVersion += 1;

      const { data: cooldown, error: cooldownError } = await service.from("paper_liquidations")
        .select("cooldown_until").eq("epoch_id", epochId).eq("asset", snapshot.asset)
        .not("cooldown_until", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (cooldownError) throw new Error(cooldownError.message);
      if (!position || (cooldown?.cooldown_until && Date.parse(cooldown.cooldown_until) > Date.now())) {
        return { mutated: data === true };
      }
      const [{ data: currentSummary, error: currentSummaryError }, { data: currentPositions, error: currentPositionsError }] = await Promise.all([
        service.from("paper_account_summaries").select("cash_balance").eq("epoch_id", epochId).single(),
        service.from("paper_positions").select("asset,margin_mode,signed_size,entry_price,mark_price,isolated_margin").eq("epoch_id", epochId),
      ]);
      if (currentSummaryError || currentPositionsError) throw new Error(currentSummaryError?.message ?? currentPositionsError?.message);
      const currentStored = (currentPositions ?? []).find((item) => item.asset === snapshot.asset);
      if (!currentStored) return { mutated: true };
      position = { signedSize: String(currentStored.signed_size), entryPrice: String(currentStored.entry_price) };
      const currentNotional = decimalString(decimal(position.signedSize).abs().times(payload.markPrice));
      const requiredMaintenance = maintenanceMargin(currentNotional, payload.metadata.marginTiers);
      let risk;
      if (currentStored.margin_mode === "isolated") {
        risk = isolatedRisk(String(currentStored.isolated_margin ?? 0), unrealizedPnl(position, payload.markPrice), requiredMaintenance);
      } else {
        const metadataByAsset = new Map(payload.catalog.map((item) => [item.asset, item]));
        const isolatedReservations = (currentPositions ?? []).filter((item) => item.margin_mode === "isolated")
          .reduce((sum, item) => sum.plus(item.isolated_margin ?? 0), decimal(0));
        risk = crossRisk(decimalString(decimal(currentSummary.cash_balance).minus(isolatedReservations)),
          (currentPositions ?? []).filter((item) => item.margin_mode === "cross").flatMap((item) => {
            const metadata = metadataByAsset.get(item.asset);
            if (!metadata) return [];
            const mark = item.asset === snapshot.asset ? payload.markPrice : String(item.mark_price);
            const paperPosition = { signedSize: String(item.signed_size), entryPrice: String(item.entry_price) };
            return [{
              unrealizedPnl: unrealizedPnl(paperPosition, mark),
              maintenanceMargin: maintenanceMargin(decimalString(decimal(item.signed_size).abs().times(mark)), metadata.marginTiers),
            }];
          }));
      }
      const liquidation = buildLiquidationEffect({
        asset: snapshot.asset, position, markPrice: payload.markPrice,
        equity: risk.equity, maintenanceMargin: risk.maintenanceMargin,
        book: payload.book, feeRate: payload.feeRates.taker,
        inputVersion: snapshot.inputVersion, nowMs: Date.now(),
      });
      if (!liquidation) return { mutated: true };
      const { data: liquidationApplied, error: liquidationError } = await service.rpc("apply_paper_liquidation_effect", {
        p_epoch_id: epochId, p_expected_version: expectedVersion, p_effect: liquidation,
      });
      if (liquidationError) throw new Error(liquidationError.message);
      return { mutated: liquidationApplied === true };
    },
  };
  return {
    enabled: Deno.env.get("PAPER_PROCESSOR_ENABLED") === "true",
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
