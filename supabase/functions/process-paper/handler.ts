import { authorizeInternal } from "../_shared/auth.ts";
import type { PaperProcessorResult } from "./processor.ts";

export interface ProcessPaperDependencies {
  enabled: boolean;
  schedulerSecret: string;
  claim(bucket: string): Promise<boolean>;
  process(): Promise<PaperProcessorResult>;
  finish(bucket: string, state: "succeeded" | "partial" | "failed", metrics: Record<string, unknown>): Promise<void>;
  now(): number;
}

export function tenSecondBucket(nowMs: number): string {
  return new Date(Math.floor(nowMs / 10_000) * 10_000).toISOString();
}

export async function handleProcessPaper(request: Request, dependencies: ProcessPaperDependencies): Promise<Response> {
  const authError = authorizeInternal(request, dependencies.schedulerSecret);
  if (authError) return authError;
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (!dependencies.enabled) return Response.json({ status: "disabled" });

  const bucket = tenSecondBucket(dependencies.now());
  const claimed = await dependencies.claim(bucket);
  if (!claimed) return Response.json({ status: "already_claimed_or_overlapping", bucket });
  try {
    const result = await dependencies.process();
    await dependencies.finish(bucket, result.state, {
      ...result,
      projectedInvocations: 259_200,
      details: { degradedAssets: result.degradedAssets },
    });
    return Response.json({ bucket, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dependencies.finish(bucket, "failed", { details: { error: message } });
    return Response.json({ error: "paper_processor_failed", detail: message, bucket }, { status: 500 });
  }
}
