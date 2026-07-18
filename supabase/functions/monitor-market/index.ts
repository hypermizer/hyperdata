import { authorizeInternal } from "../_shared/auth.ts";
import { loadRuntimeConfig } from "../_shared/config.ts";
import { createServiceClient } from "../_shared/database.ts";
import type { AlertRule } from "../_shared/types.ts";
import { collectMarketObservations } from "./collector.ts";
import { evaluateRules } from "./evaluator.ts";
import { classifyRun, storageProjectionBytes, utcMinute } from "./health.ts";

export async function handleMonitor(request: Request): Promise<Response> {
  const config = loadRuntimeConfig(); const authError = authorizeInternal(request, config.monitorSecret); if (authError) return authError;
  const client = createServiceClient(config.supabaseUrl, config.serviceRoleKey); const bucket = utcMinute(); const startedAt = new Date();
  const { data: claimed, error: claimError } = await client.rpc("claim_monitor_bucket", { p_bucket: bucket.toISOString() });
  if (claimError) return Response.json({ error: claimError.message }, { status: 500 });
  if (!claimed) return Response.json({ status: "already_claimed", bucket: bucket.toISOString() });
  try {
    const [{ data: rulesData, error: rulesError }, { data: watchlist, error: watchlistError }] = await Promise.all([
      client.from("alert_rules").select("*").eq("enabled", true).is("deleted_at", null), client.from("watchlist_items").select("asset"),
    ]);
    if (rulesError || watchlistError) throw new Error(rulesError?.message ?? watchlistError?.message);
    const rules = (rulesData ?? []) as AlertRule[]; const dexByAsset = new Map(rules.map((rule) => [rule.asset, rule.dex]));
    const assets = [...new Set([...rules.map((rule) => rule.asset), ...(watchlist ?? []).map((item) => item.asset)])].map((asset) => ({ asset, dex: dexByAsset.get(asset) ?? (asset.includes(":") ? asset.split(":")[0] : "") }));
    const collected = await collectMarketObservations(client, assets, bucket); const evaluated = await evaluateRules(client, rules, collected.observations, bucket);
    const failureCount = Object.keys(collected.failures).length + evaluated.errors.length; const state = classifyRun(collected.observations.length, assets.length, failureCount);
    const details = { dexFailures: collected.failures, evaluationErrors: evaluated.errors, projected30DayBytes: storageProjectionBytes(assets.length) };
    await client.from("monitor_runs").update({ state, finished_at: new Date().toISOString(), lease_until: null, assets_checked: collected.observations.length,
      rules_checked: rules.length, occurrences_created: evaluated.occurrences, details }).eq("bucket", bucket.toISOString());
    return Response.json({ state, bucket: bucket.toISOString(), durationMs: Date.now() - startedAt.getTime(), ...details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.from("monitor_runs").update({ state: "failed", finished_at: new Date().toISOString(), lease_until: null, details: { error: message } }).eq("bucket", bucket.toISOString());
    return Response.json({ error: message }, { status: 500 });
  }
}
if (import.meta.main) Deno.serve(handleMonitor);
