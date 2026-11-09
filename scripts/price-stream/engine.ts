import type { AlertRule } from "../../supabase/functions/_shared/types.ts";

export type StreamRule = AlertRule & { updated_at: string };
export interface Candidate {
  key: string; ruleId: string; revision: string; asset: string; mark: number; observedAt: string;
}

// Keep the first qualifying tick, even when a following tick reverses before a DB write.
// Durable candidates survive a process restart and a database outage.
export class PriceAlertEngine {
  rules: StreamRule[] = [];
  readonly pending = new Map<string, Candidate>();
  private writes: Promise<void> = Promise.resolve();
  constructor(candidates: Candidate[], private save: (rows: Candidate[]) => Promise<void>) {
    for (const row of candidates) this.pending.set(row.key, row);
  }
  setRules(rules: StreamRule[]) {
    this.rules = rules.filter((rule) => rule.enabled && !rule.deleted_at && rule.detector === "fixed_price");
  }
  accept(asset: string, mark: number, receivedAt: number) {
    if (!Number.isFinite(mark) || mark <= 0 || !Number.isFinite(receivedAt)) return;
    let added = false;
    for (const rule of this.rules) {
      if (rule.asset !== asset || receivedAt < Date.parse(rule.updated_at)) continue;
      const target = Number(rule.configuration.target);
      if (!Number.isFinite(target) || target <= 0) continue;
      const qualifies = rule.configuration.direction === "above" ? mark >= target
        : rule.configuration.direction === "below" ? mark <= target : false;
      const key = `${rule.id}/${rule.updated_at}`;
      if (!qualifies || this.pending.has(key)) continue;
      this.pending.set(key, { key, ruleId: rule.id, revision: rule.updated_at, asset, mark, observedAt: new Date(receivedAt).toISOString() });
      added = true;
    }
    if (added) this.persist();
    return added;
  }
  private persist() {
    const snapshot = [...this.pending.values()];
    this.writes = this.writes.then(() => this.save(snapshot));
    // Preserve rejection for settled(), without an unhandled rejection in the event loop.
    this.writes.catch(() => {});
  }
  async settled() {
    // Ticks may append another disk write while the previous one is syncing.
    for (;;) { const current = this.writes; await current; if (current === this.writes) return; }
  }
  async remove(key: string) { this.pending.delete(key); this.persist(); await this.settled(); }
}

export function parseMarkFrame(payload: string): { asset: string; mark: number } | null {
  try {
    const frame = JSON.parse(payload);
    if (frame.channel !== "activeAssetCtx" || typeof frame.data?.coin !== "string") return null;
    const raw = frame.data.ctx?.markPx;
    if (typeof raw !== "number" && typeof raw !== "string" || raw === "") return null;
    const mark = Number(raw);
    return Number.isFinite(mark) && mark > 0 ? { asset: frame.data.coin, mark } : null;
  } catch { return null; }
}
