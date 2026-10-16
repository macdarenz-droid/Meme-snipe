// The consumer-side credit meter (SPEC-A A-M14-05 logic 2 and 3, card Z08). Before every request to a metered
// provider the gateway asks `take`: the request is drawn from a block of at most `rpc.reserve_block_units` (≤ 1,000)
// that was written to the account ledger before the block's first send, or, when the block is used up, a new block
// is reserved first (a block left unused at a crash counts as spent). A refusal happens before the request is sent.
// Near the cap a smaller reservation of exactly the request's cost is tried, so the last units stay usable.
//
// Fail closed: a ledger that cannot be opened, read or written refuses the send (`m14.ledger_unavailable`, critical,
// once per episode) and is tried again on the next send, so the month never halts for good (Zeroed round 4 item 9)
// and a failed write never spends the cap (round 4 item 7). The projection (`projectedOver80`) reads the ledger at
// most once a minute per provider; when the ledger cannot be read the provider counts as projected over (fail closed).
import type { UnixMs } from '@bot/types';
import type { UsageLedgerPort } from '../m24/usage-ledger.ts';
import type { LogPort } from './types.ts';
import {
  monthKeyUtc, projectedOver, projectMonthEnd, unitsFor, type AccountCap, type LedgerCounts, type Metering, type Outcome,
} from './usage.ts';

/** The projection is recomputed at most this often per provider. */
export const PROJECTION_CACHE_MS = 60_000;

export interface MeterDeps {
  consumer: string;
  /** Every metered provider this process may send to, with its metering (methods' costs, documented allowance). */
  providers: ReadonlyArray<{ label: string; metering: Metering }>;
  /** This consumer's caps (`consumerCaps`). A metered provider without one is never sent to. */
  caps: readonly AccountCap[];
  /** `rpc.reserve_block_units`, 1-1,000. */
  blockUnits: number;
  /** `rpc.burn.alert_bps`, 5,000-9,500. */
  alertBps: number;
  /** Opens the ledger; throws when it cannot. Called lazily and again after any ledger failure. */
  openLedger: () => UsageLedgerPort;
  /** Wall clock (UTC months, the rolling window). */
  nowMs: () => UnixMs;
  log: LogPort;
}

export interface CreditUsage { provider: string; usedThisMonth: number; monthlyAllowance: number; projectedMonthEnd: number }

export interface UsageMeter {
  /** Before a request: true when it may be sent (its cost is already written to the ledger). */
  take(provider: string, method: string): boolean;
  /** After a sent request's answer (the four ledger counts). */
  record(provider: string, outcome: Outcome): void;
  /** A-M14-02 step 6: true sends P1-P4 traffic away from the provider. */
  projectedOver80(provider: string): boolean;
  creditUsage(): CreditUsage[];
  counts(provider: string): LedgerCounts | null;
}

export function createUsageMeter(deps: MeterDeps): UsageMeter {
  if (!Number.isSafeInteger(deps.blockUnits) || deps.blockUnits < 1 || deps.blockUnits > 1_000) throw new RangeError('blockUnits must be 1-1,000');
  if (!Number.isSafeInteger(deps.alertBps) || deps.alertBps < 5_000 || deps.alertBps > 9_500) throw new RangeError('alertBps must be 5,000-9,500');
  const metering = new Map(deps.providers.map((p) => [p.label, p.metering]));
  const caps = new Map(deps.caps.map((c) => [c.provider, c]));
  const blockLeft = new Map<string, number>();
  const projection = new Map<string, { atMs: number; projected: number; used: number; over: boolean }>();
  const overAlerted = new Set<string>();
  let ledger: UsageLedgerPort | null = null;
  let down = false;

  const withLedger = <T>(fn: (l: UsageLedgerPort) => T, provider: string): { ok: true; value: T } | { ok: false } => {
    try {
      ledger ??= deps.openLedger();
      const value = fn(ledger);
      if (down) { down = false; deps.log.event('info', 'm14.ledger_recovered', { provider }); }
      return { ok: true, value };
    } catch {
      try { ledger?.close(); } catch { /* already broken */ }
      ledger = null;
      if (!down) { down = true; deps.log.event('critical', 'm14.ledger_unavailable', { provider }); }
      return { ok: false };
    }
  };

  const project = (provider: string, m: Metering): { projected: number; used: number; over: boolean } | null => {
    const now = deps.nowMs();
    const cached = projection.get(provider);
    if (cached !== undefined && now - cached.atMs < PROJECTION_CACHE_MS && now >= cached.atMs) return cached;
    const t = withLedger((l) => l.totals(provider, deps.consumer, now), provider);
    if (!t.ok) { projection.delete(provider); return null; }
    const projected = projectMonthEnd(t.value.monthToDate, t.value.last24h, now);
    const over = projectedOver(projected, m.monthlyAllowance, deps.alertBps);
    if (over && !overAlerted.has(provider)) {
      overAlerted.add(provider);
      deps.log.event('warn', 'm14.burn_projection', { provider, projected: Math.round(projected), allowance: m.monthlyAllowance, alert_bps: deps.alertBps });
    } else if (!over) {
      overAlerted.delete(provider);
    }
    const v = { atMs: now, projected, used: t.value.monthToDate, over };
    projection.set(provider, v);
    return v;
  };

  const reserve = (provider: string, units: number, cap: AccountCap): 'ok' | 'refused' | 'failed' => {
    const r = withLedger((l) => l.reserve({
      provider, consumer: deps.consumer, units, atMs: deps.nowMs(), accountCap: cap.accountCap, consumerCap: cap.consumerCap,
    }), provider);
    if (!r.ok) return 'failed';
    return r.value === 'ok' ? 'ok' : 'refused';
  };

  return {
    take(provider: string, method: string): boolean {
      const m = metering.get(provider);
      if (m === undefined) return true;                                // unmetered
      const cap = caps.get(provider);
      if (cap === undefined || cap.consumerCap === 0) return false;
      const cost = unitsFor(m, method);
      const left = blockLeft.get(provider) ?? 0;
      if (left >= cost) {
        blockLeft.set(provider, left - cost);
        withLedger((l) => l.count(provider, deps.consumer, deps.nowMs(), 'attempt'), provider);
        return true;
      }
      // A new block: the whole block size, or exactly this request's cost when the block does not fit under the caps.
      const size = Math.max(cost, deps.blockUnits);
      let got = reserve(provider, size, cap);
      let granted = size;
      if (got === 'refused' && size > cost) { got = reserve(provider, cost, cap); granted = cost; }
      if (got !== 'ok') {
        if (got === 'refused') deps.log.event('warn', 'm14.credit_cap_reached', { provider, method, units: cost });
        return false;
      }
      blockLeft.set(provider, granted - cost);                         // the rest of the old block stays spent
      projection.delete(provider);
      withLedger((l) => l.count(provider, deps.consumer, deps.nowMs(), 'attempt'), provider);
      return true;
    },
    record(provider: string, outcome: Outcome): void {
      if (!metering.has(provider)) return;
      withLedger((l) => l.count(provider, deps.consumer, deps.nowMs(), outcome), provider);
    },
    projectedOver80(provider: string): boolean {
      const m = metering.get(provider);
      if (m === undefined) return false;
      return project(provider, m)?.over ?? true;
    },
    creditUsage(): CreditUsage[] {
      const out: CreditUsage[] = [];
      for (const [provider, m] of metering) {
        const p = project(provider, m);
        out.push({ provider, usedThisMonth: p?.used ?? Number.NaN, monthlyAllowance: m.monthlyAllowance, projectedMonthEnd: p?.projected ?? Number.NaN });
      }
      return out;
    },
    counts(provider: string): LedgerCounts | null {
      if (!metering.has(provider)) return null;
      const r = withLedger((l) => l.counts(provider, deps.consumer, monthKeyUtc(deps.nowMs())), provider);
      return r.ok ? r.value : null;
    },
  };
}
