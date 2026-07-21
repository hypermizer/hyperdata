import { createClient } from "@supabase/supabase-js";
import { createServiceClient } from "../_shared/database.ts";
import { handleStrategyCommand, type StrategyCommand, type StrategyCommandDependencies } from "./handler.ts";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

function required(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function rpcFor(command: StrategyCommand) {
  switch (command.type) {
    case "create_definition": return ["create_dual_rsi_strategy", { p_name: command.name, p_margin_allocation_pct: command.marginAllocationPct }] as const;
    case "create_assignment": return ["create_strategy_assignment", { p_definition_id: command.definitionId, p_account_id: command.accountId, p_asset: command.asset, p_margin_allocation_pct: command.marginAllocationPct }] as const;
    case "set_assignment_state": return ["set_strategy_assignment_state", { p_assignment_id: command.assignmentId, p_state: command.state, p_pause_mode: command.pauseMode ?? null }] as const;
    case "queue_backtest": return ["queue_strategy_backtest", { p_revision_id: command.revisionId, p_assets: command.assets, p_start: command.start, p_end: command.end, p_initial_capital: command.initialCapital }] as const;
  }
}

function dependencies(): StrategyCommandDependencies {
  const url = required("SUPABASE_URL");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = required("SUPABASE_ANON_KEY");
  const service = createServiceClient(url, serviceKey);
  return {
    enabled: Deno.env.get("STRATEGY_COMMAND_ENABLED") === "true",
    async authenticate(token) {
      const { data, error } = await service.auth.getUser(token);
      if (error || !data.user) return null;
      return { id: data.user.id, email: data.user.email ?? null };
    },
    async execute(_user, command, token) {
      const client = createClient(url, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const [name, args] = rpcFor(command);
      const { data, error } = await client.rpc(name, args);
      if (error) throw new Error(error.message);
      return data;
    },
  };
}

export async function serveStrategyCommand(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const response = await handleStrategyCommand(request, dependencies());
    const headers = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return Response.json({ error: "strategy_command_configuration", detail: error instanceof Error ? error.message : String(error) }, { status: 500, headers: corsHeaders });
  }
}

if (import.meta.main) Deno.serve(serveStrategyCommand);
