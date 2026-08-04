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

async function replacePositions(service: SupabaseClient, source: AccountSyncSource, positions: Record<string, unknown>[]) {
  await upsertChunks(service, "hyperliquid_account_positions", positions, "account_address,dex,asset");
  const { data: existing, error } = await service.from("hyperliquid_account_positions")
    .select("dex,asset").eq("user_id", source.user_id).eq("account_address", source.address);
  if (error) throw new Error(`hyperliquid_account_positions: ${error.message}`);
  const currentKeys = new Set(positions.map((position) => `${position.dex}\u0000${position.asset}`));
  for (const stale of existing ?? []) {
    if (currentKeys.has(`${stale.dex}\u0000${stale.asset}`)) continue;
    const deletion = await service.from("hyperliquid_account_positions").delete()
      .eq("user_id", source.user_id).eq("account_address", source.address).eq("dex", stale.dex).eq("asset", stale.asset);
    if (deletion.error) throw new Error(`hyperliquid_account_positions: ${deletion.error.message}`);
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
    const funding = await Promise.all(fundingWindow.items.map((item) => normalizeFunding(source.user_id, source.address, item)));
    const ledger = await Promise.all(ledgerWindow.items.map((item) => normalizeLedger(source.user_id, source.address, item)));
    await upsertChunks(service, "hyperliquid_account_fills", fills, "account_address,trade_id");
    await upsertChunks(service, "hyperliquid_account_funding", funding, "account_address,event_key");
    await upsertChunks(service, "hyperliquid_account_ledger", ledger, "account_address,event_key");
    await replacePositions(service, source, positions);
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
