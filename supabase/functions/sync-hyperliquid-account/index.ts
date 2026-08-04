import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../_shared/database.ts";
import { handleAccountSync, type AccountSyncDependencies, type AccountSyncSource } from "./handler.ts";
import {
  fetchInfo,
  fetchPositions,
  fetchTimeWindow,
  normalizeFill,
  normalizeFunding,
  normalizeLedger,
} from "./sync.ts";

const UPSERT_CHUNK_SIZE = 500;

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function upsertChunks(service: SupabaseClient, table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK_SIZE) {
    const { error } = await service.from(table).upsert(rows.slice(offset, offset + UPSERT_CHUNK_SIZE), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

export async function syncSource(service: SupabaseClient, source: AccountSyncSource, now = Date.now()) {
  try {
    const [fillsWindow, fundingWindow, ledgerWindow, positions] = await Promise.all([
      fetchTimeWindow("userFillsByTime", source.address, source.fills_cursor_ms, now),
      fetchTimeWindow("userFunding", source.address, source.funding_cursor_ms, now),
      fetchTimeWindow("userNonFundingLedgerUpdates", source.address, source.ledger_cursor_ms, now),
      fetchPositions(source.user_id, source.address, now, fetchInfo),
    ]);
    const fills = fillsWindow.items.map((item) => normalizeFill(source.user_id, source.address, item));
    const funding = fundingWindow.items.map((item) => normalizeFunding(source.user_id, source.address, item));
    const ledger = ledgerWindow.items.map((item) => normalizeLedger(source.user_id, source.address, item));
    await upsertChunks(service, "hyperliquid_account_fills", fills, "account_address,trade_id");
    await upsertChunks(service, "hyperliquid_account_funding", funding, "account_address,event_key");
    await upsertChunks(service, "hyperliquid_account_ledger", ledger, "account_address,event_key");
    const positionResult = await service.rpc("replace_hyperliquid_account_positions", {
      p_user_id: source.user_id, p_address: source.address,
      p_observed_at: new Date(now).toISOString(), p_positions: positions,
    });
    if (positionResult.error) throw new Error(`hyperliquid_account_positions: ${positionResult.error.message}`);
    const { error } = await service.rpc("finish_hyperliquid_account_sync", {
      p_user_id: source.user_id, p_succeeded: true,
      p_fills_cursor_ms: fillsWindow.cursorMs, p_funding_cursor_ms: fundingWindow.cursorMs,
      p_ledger_cursor_ms: ledgerWindow.cursorMs, p_error: null,
    });
    if (error) throw new Error(`finish_hyperliquid_account_sync: ${error.message}`);
    return { fills: fills.length, funding: funding.length, ledger: ledger.length, positions: positions.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await service.rpc("finish_hyperliquid_account_sync", {
      p_user_id: source.user_id, p_succeeded: false,
      p_fills_cursor_ms: null, p_funding_cursor_ms: null, p_ledger_cursor_ms: null, p_error: message,
    });
    throw error;
  }
}

export function runtimeDependencies(): AccountSyncDependencies {
  const service = createServiceClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  return {
    schedulerSecret: required("MONITOR_SECRET"),
    async claim() {
      const { data, error } = await service.rpc("claim_hyperliquid_account_source", { p_lease_seconds: 90 }).maybeSingle();
      if (error) throw new Error(error.message);
      return data as AccountSyncSource | null;
    },
    sync: (source) => syncSource(service, source),
  };
}

export async function serveAccountSync(request: Request): Promise<Response> {
  try {
    return await handleAccountSync(request, runtimeDependencies());
  } catch (error) {
    return Response.json({ error: "account_sync_failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

if (import.meta.main) Deno.serve(serveAccountSync);
