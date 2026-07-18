import { authorizeInternal } from "../_shared/auth.ts";
import { loadRuntimeConfig } from "../_shared/config.ts";
import { createServiceClient } from "../_shared/database.ts";
import { buildBootstrapModel, fetchCalibrationCandles } from "./bootstrap.ts";

export async function handleCalibration(request: Request): Promise<Response> {
  const config = loadRuntimeConfig(); const authError = authorizeInternal(request, config.monitorSecret); if (authError) return authError;
  const client = createServiceClient(config.supabaseUrl, config.serviceRoleKey);
  const { data: jobs, error } = await client.rpc("claim_calibration_jobs", { p_limit: 3 }); if (error) return Response.json({ error: error.message }, { status: 500 });
  const outcomes = [];
  for (const job of jobs ?? []) {
    try {
      const marks = await fetchMarkHistory(client, job.asset, job.horizon_minutes);
      let source: "mark_history" | "trade_candle_bootstrap" = "mark_history";
      let model: ReturnType<typeof buildBootstrapModel> | undefined;
      if (marks.length >= job.horizon_minutes + 101) {
        try { model = buildBootstrapModel(marks.map((item) => ({ T: Date.parse(item.bucket), c: item.mark_price })), job.horizon_minutes, 1, "marks"); }
        catch { /* Incomplete forward mark coverage falls back to labeled trade candles. */ }
      }
      if (!model) {
        source = "trade_candle_bootstrap";
        const history = await fetchCalibrationCandles(job.asset, job.horizon_minutes);
        model = buildBootstrapModel(history.candles, job.horizon_minutes, history.intervalMinutes, "bootstrap");
      }
      const { error: modelError } = await client.from("detector_models").upsert({ asset: job.asset, horizon_minutes: job.horizon_minutes, detector: "large_move",
        model_version: model.modelVersion, source, parameters: model.parameters, sample_count: model.sampleCount,
        coverage_start: model.coverageStart, coverage_end: model.coverageEnd, valid_from: new Date().toISOString(), expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
        { onConflict: "asset,horizon_minutes,detector,model_version" });
      if (modelError) throw modelError;
      await client.from("calibration_jobs").update({ state: "complete", lease_until: null, last_error: null, available_at: new Date(Date.now() + 24 * 3600_000).toISOString() })
        .eq("asset", job.asset).eq("horizon_minutes", job.horizon_minutes);
      outcomes.push({ asset: job.asset, horizon: job.horizon_minutes, status: "complete", samples: model.sampleCount });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      await client.from("calibration_jobs").update({ state: "failed", lease_until: null, last_error: message, available_at: new Date(Date.now() + 15 * 60_000).toISOString() })
        .eq("asset", job.asset).eq("horizon_minutes", job.horizon_minutes);
      outcomes.push({ asset: job.asset, horizon: job.horizon_minutes, status: "failed", error: message });
    }
  }
  return Response.json({ outcomes });
}
if (import.meta.main) Deno.serve(handleCalibration);

async function fetchMarkHistory(client: ReturnType<typeof createServiceClient>, asset: string, horizonMinutes: number) {
  const targetRows = Math.min(15_000, Math.max(500, horizonMinutes + 1_000)); const rows: Array<{ bucket: string; mark_price: number }> = [];
  for (let offset = 0; offset < targetRows; offset += 1_000) {
    const { data, error } = await client.from("market_observations").select("bucket,mark_price").eq("asset", asset).order("bucket", { ascending: false })
      .range(offset, Math.min(offset + 999, targetRows - 1));
    if (error) throw new Error(error.message); rows.push(...(data ?? [])); if (!data || data.length < 1_000) break;
  }
  return rows.reverse();
}
