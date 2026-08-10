import { authorizeInternal } from "../_shared/auth.ts";
import { loadRuntimeConfig } from "../_shared/config.ts";
import { createServiceClient } from "../_shared/database.ts";
import type { AlertRule } from "../_shared/types.ts";
import { deliverPending } from "../deliver-alerts/service.ts";
import { recordAssetAnalyticsSnapshot } from "./analytics.ts";
import { assetIdsForBucket, isAnalyticsBucket, isMinuteBucket, MONITOR_INTERVAL_SECONDS, monitorBucket, rulesForBucket } from "./cadence.ts";
import { collectMarketObservations } from "./collector.ts";
import { evaluateRules } from "./evaluator.ts";
import { classifyRun, storageProjectionBytes } from "./health.ts";

export async function handleMonitor(request: Request): Promise<Response> {
  const config = loadRuntimeConfig(); const authError = authorizeInternal(request, config.monitorSecret); if (authError) return authError;
  const client = createServiceClient(config.supabaseUrl, config.serviceRoleKey); const bucket = monitorBucket(); const startedAt = new Date();
  const { data: claimed, error: claimError } = await client.rpc("claim_monitor_bucket", { p_bucket: bucket.toISOString() });
  if (claimError) return Response.json({ error: claimError.message }, { status: 500 });
  if (!claimed) return Response.json({ status: "already_claimed", bucket: bucket.toISOString() });
  try {
    const [{ data: rulesData, error: rulesError }, { data: watchlist, error: watchlistError }] = await Promise.all([
      client.from("alert_rules").select("*").eq("enabled", true).is("deleted_at", null), client.from("watchlist_items").select("asset"),
    ]);
    if (rulesError || watchlistError) throw new Error(rulesError?.message ?? watchlistError?.message);
    const rules = (rulesData ?? []) as AlertRule[]; const activeRules = rulesForBucket(rules, bucket); const minuteBucket = isMinuteBucket(bucket);
    const dexByAsset = new Map(rules.map((rule) => [rule.asset, rule.dex]));
    const assets = assetIdsForBucket(rules, watchlist ?? [], bucket)
      .map((asset) => ({ asset, dex: dexByAsset.get(asset) ?? (asset.includes(":") ? asset.split(":")[0] : "") }));
    const collected = await collectMarketObservations(client, assets, bucket, { persist: minuteBucket, retries: 0 });
    const evaluated = await evaluateRules(client, activeRules, collected.observations, bucket, { updateVolatility: minuteBucket });
    const [analyticsResult, deliveryResult] = await Promise.allSettled([
      isAnalyticsBucket(bucket) ? recordAssetAnalyticsSnapshot(client, bucket) : Promise.resolve(0),
      config.deliveryEnabled ? deliverPending(client) : Promise.resolve([]),
    ]);
    const analyticsUpdated = analyticsResult.status === "fulfilled" ? analyticsResult.value : 0;
    const analyticsError = analyticsResult.status === "rejected"
      ? analyticsResult.reason instanceof Error ? analyticsResult.reason.message : String(analyticsResult.reason)
      : null;
    const deliveryOutcomes: Array<{ id: string; state: string }> = deliveryResult.status === "fulfilled" ? deliveryResult.value : [];
    const deliveryError = deliveryResult.status === "rejected"
      ? deliveryResult.reason instanceof Error ? deliveryResult.reason.message : String(deliveryResult.reason)
      : null;
    const unsuccessfulDeliveries = deliveryOutcomes.filter(({ state: deliveryState }) => deliveryState !== "sent").length;
    const failureCount = Object.keys(collected.failures).length + evaluated.errors.length + unsuccessfulDeliveries
      + Number(Boolean(deliveryError)) + Number(Boolean(analyticsError));
    const state = classifyRun(collected.observations.length, assets.length, failureCount);
    const details = { dexFailures: collected.failures, evaluationErrors: evaluated.errors, deliveryOutcomes, deliveryError,
      analyticsUpdated, analyticsError, cadenceSeconds: MONITOR_INTERVAL_SECONDS, persistedObservation: minuteBucket,
      projected30DayBytes: storageProjectionBytes(assets.length) };
    await client.from("monitor_runs").update({ state, finished_at: new Date().toISOString(), lease_until: null, assets_checked: collected.observations.length,
      rules_checked: activeRules.length, occurrences_created: evaluated.occurrences, details }).eq("bucket", bucket.toISOString());
    return Response.json({ state, bucket: bucket.toISOString(), durationMs: Date.now() - startedAt.getTime(), ...details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.from("monitor_runs").update({ state: "failed", finished_at: new Date().toISOString(), lease_until: null, details: { error: message } }).eq("bucket", bucket.toISOString());
    return Response.json({ error: message }, { status: 500 });
  }
}
if (import.meta.main) Deno.serve(handleMonitor);
