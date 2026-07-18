import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateRule } from "../_shared/detectors/registry.ts";
import { logReturn } from "../_shared/statistics/returns.ts";
import { updateVariance } from "../_shared/statistics/robust-volatility.ts";
import type { AlertRule, DetectorModel, MarketObservation, VolatilityState } from "../_shared/types.ts";

export async function evaluateRules(client: SupabaseClient, rules: AlertRule[], observations: MarketObservation[], bucket: Date): Promise<{ occurrences: number; errors: string[] }> {
  const currentByAsset = new Map(observations.map((item) => [item.asset, item])); let occurrences = 0; const errors: string[] = [];
  const assets = [...currentByAsset.keys()];
  const { data: stateRows, error: statesError } = assets.length ? await client.from("volatility_states").select("*").in("asset", assets) : { data: [], error: null };
  if (statesError) throw new Error(statesError.message);
  const states = new Map((stateRows ?? []).map((item) => [item.asset, item as VolatilityState]));
  const pairContexts = new Map<string, Promise<{ reference?: MarketObservation; model?: DetectorModel }>>();
  for (const rule of rules.filter((item) => item.detector === "large_move")) {
    const horizon = Number(rule.configuration.horizon_minutes); const key = `${rule.asset}:${horizon}`;
    if (pairContexts.has(key)) continue;
    pairContexts.set(key, loadMoveContext(client, rule.asset, horizon, bucket));
  }
  const resolvedContexts = new Map(await Promise.all([...pairContexts].map(async ([key, value]) => [key, await value] as const)));
  for (const rule of rules) {
    const current = currentByAsset.get(rule.asset); if (!current) continue;
    try {
      const horizon = Number(rule.configuration.horizon_minutes); const context = resolvedContexts.get(`${rule.asset}:${horizon}`) ?? {};
      const result = evaluateRule(rule, { current, ...context, volatilityState: states.get(rule.asset) });
      const { error: stateError } = await client.from("rule_evaluation_state").upsert({ rule_id: rule.id, bucket: bucket.toISOString(), status: result.status,
        score: result.score, tail_percentile: result.tailPercentile, reference_age_seconds: result.referenceAgeSeconds, model_version: result.modelVersion, details: result.evidence });
      if (stateError) throw stateError;
      if (result.qualifies) {
        const { data, error } = await client.rpc("record_alert_occurrence", { p_rule_id: rule.id, p_bucket: bucket.toISOString(), p_mark_price: current.mark_price,
          p_classification: result.classification, p_evidence: result.evidence });
        if (error) throw error; if (data) occurrences += 1;
      }
    } catch (error) { errors.push(`${rule.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await updateOnlineStates(client, observations, states, bucket);
  return { occurrences, errors };
}

async function loadMoveContext(client: SupabaseClient, asset: string, horizon: number, bucket: Date) {
  const target = new Date(bucket.getTime() - horizon * 60_000);
  const [referenceResponse, modelResponse] = await Promise.all([
    client.from("market_observations").select("*").eq("asset", asset).gte("bucket", new Date(target.getTime() - 75_000).toISOString())
      .lte("bucket", new Date(target.getTime() + 75_000).toISOString()).order("bucket", { ascending: false }).limit(1),
    client.from("detector_models").select("*").eq("asset", asset).eq("horizon_minutes", horizon).eq("detector", "large_move")
      .gt("expires_at", new Date().toISOString()).order("expires_at", { ascending: false }).limit(1),
  ]);
  if (referenceResponse.error || modelResponse.error) throw new Error(referenceResponse.error?.message ?? modelResponse.error?.message);
  return { reference: referenceResponse.data?.[0] as MarketObservation | undefined, model: modelResponse.data?.[0] as DetectorModel | undefined };
}

async function updateOnlineStates(client: SupabaseClient, observations: MarketObservation[], states: Map<string, VolatilityState>, bucket: Date) {
  const updates = observations.flatMap((current) => {
    const state = states.get(current.asset); if (!state) return [];
    const age = bucket.getTime() - Date.parse(state.last_bucket); if (age <= 0 || age > 120_000) return [];
    const residual = logReturn(current.mark_price, state.last_mark);
    return [{ asset: current.asset, fast_variance: updateVariance(state.fast_variance, residual, 30), slow_variance: updateVariance(state.slow_variance, residual, 360),
      last_mark: current.mark_price, last_bucket: current.bucket }];
  });
  const missingCurrent = observations.filter((item) => !states.has(item.asset));
  let missing: Array<{ asset: string; fast_variance: number; slow_variance: number; last_mark: number; last_bucket: string }> = [];
  if (missingCurrent.length) {
    const previousBucket = new Date(bucket.getTime() - 60_000).toISOString();
    const { data, error } = await client.from("market_observations").select("asset,mark_price").in("asset", missingCurrent.map((item) => item.asset)).eq("bucket", previousBucket);
    if (error) throw new Error(error.message);
    const previousMarks = new Map((data ?? []).map((item) => [item.asset, item.mark_price]));
    missing = missingCurrent.flatMap((current) => {
      const previousMark = previousMarks.get(current.asset); if (!previousMark) return [];
      const variance = Math.max(logReturn(current.mark_price, previousMark) ** 2, 1e-12);
      return [{ asset: current.asset, fast_variance: variance, slow_variance: variance, last_mark: current.mark_price, last_bucket: current.bucket }];
    });
  }
  const rows = [...updates, ...missing]; if (!rows.length) return;
  const { error } = await client.from("volatility_states").upsert(rows, { onConflict: "asset" }); if (error) throw new Error(error.message);
}
