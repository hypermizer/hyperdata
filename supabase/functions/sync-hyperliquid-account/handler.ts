import { authorizeInternal } from "../_shared/auth.ts";

export interface AccountSyncSource {
  user_id: string;
  address: string;
  fills_cursor_ms: number | null;
  funding_cursor_ms: number | null;
  ledger_cursor_ms: number | null;
}

export interface AccountSyncDependencies {
  schedulerSecret: string;
  claim(): Promise<AccountSyncSource | null>;
  sync(source: AccountSyncSource): Promise<Record<string, number>>;
}

export async function handleAccountSync(request: Request, dependencies: AccountSyncDependencies): Promise<Response> {
  const authError = authorizeInternal(request, dependencies.schedulerSecret);
  if (authError) return authError;
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const source = await dependencies.claim();
  if (!source) return Response.json({ status: "idle" });
  const result = await dependencies.sync(source);
  return Response.json({ status: "succeeded", ...result });
}
