const OWNER_EMAIL = "jasonblick@zohomail.com";
const MAX_BODY_BYTES = 16_384;

export interface StrategyCommandUser { id: string; email: string | null }
export type StrategyCommand =
  | { type: "create_definition"; name: string; marginAllocationPct: number }
  | { type: "create_revision"; definitionId: string; marginAllocationPct: number }
  | { type: "create_assignment"; definitionId: string; accountId: string; asset: string; marginAllocationPct: number }
  | { type: "set_assignment_state"; assignmentId: string; state: "paused" | "warming"; pauseMode?: "keep_exit_management" | "close_and_pause" }
  | { type: "queue_backtest"; revisionId: string; assets: string[]; start: string; end: string; initialCapital: number };

export interface StrategyCommandDependencies {
  enabled: boolean;
  authenticate(token: string): Promise<StrategyCommandUser | null>;
  execute(user: StrategyCommandUser, command: StrategyCommand, token: string): Promise<unknown>;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseStrategyCommand(value: unknown): StrategyCommand | null {
  if (!value || typeof value !== "object") return null;
  const command = value as Record<string, unknown>;
  if (command.type === "create_definition") {
    if (typeof command.name !== "string" || command.name.trim().length < 1 || command.name.trim().length > 80 ||
      typeof command.marginAllocationPct !== "number" || command.marginAllocationPct < 1 || command.marginAllocationPct > 100) return null;
    return { type: command.type, name: command.name.trim(), marginAllocationPct: command.marginAllocationPct };
  }
  if (command.type === "create_assignment") {
    if (!validUuid(command.definitionId) || !validUuid(command.accountId) || typeof command.asset !== "string" ||
      !/^[a-zA-Z0-9_.:-]+$/.test(command.asset) || typeof command.marginAllocationPct !== "number" ||
      command.marginAllocationPct < 1 || command.marginAllocationPct > 100) return null;
    return command as unknown as StrategyCommand;
  }
  if (command.type === "create_revision") {
    if (!validUuid(command.definitionId) || typeof command.marginAllocationPct !== "number" ||
      command.marginAllocationPct < 1 || command.marginAllocationPct > 100) return null;
    return command as unknown as StrategyCommand;
  }
  if (command.type === "set_assignment_state") {
    if (!validUuid(command.assignmentId) || !["paused", "warming"].includes(String(command.state)) ||
      (command.pauseMode !== undefined && !["keep_exit_management", "close_and_pause"].includes(String(command.pauseMode)))) return null;
    return command as unknown as StrategyCommand;
  }
  if (command.type === "queue_backtest") {
    if (!validUuid(command.revisionId) || !Array.isArray(command.assets) || command.assets.length < 1 || command.assets.length > 20 ||
      !command.assets.every((asset) => typeof asset === "string" && /^[a-zA-Z0-9_.:-]+$/.test(asset)) ||
      new Set(command.assets).size !== command.assets.length ||
      typeof command.start !== "string" || !Number.isFinite(Date.parse(command.start)) || typeof command.end !== "string" ||
      !Number.isFinite(Date.parse(command.end)) || Date.parse(command.end) <= Date.parse(command.start) ||
      typeof command.initialCapital !== "number" || command.initialCapital <= 0 || command.initialCapital > 1_000_000_000) return null;
    return command as unknown as StrategyCommand;
  }
  return null;
}

export async function handleStrategyCommand(request: Request, dependencies: StrategyCommandDependencies): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return Response.json({ error: "unauthorized" }, { status: 401 });
  const token = authorization.slice(7);
  const user = await dependencies.authenticate(token);
  if (!user || user.email?.toLowerCase() !== OWNER_EMAIL) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!dependencies.enabled) return Response.json({ error: "strategy_commands_disabled" }, { status: 503 });
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return Response.json({ error: "request_too_large" }, { status: 413 });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const command = parseStrategyCommand(raw);
  if (!command) return Response.json({ error: "invalid_command" }, { status: 400 });
  try { return Response.json({ result: await dependencies.execute(user, command, token) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: "strategy_command_failed", detail: message }, { status: 422 });
  }
}
