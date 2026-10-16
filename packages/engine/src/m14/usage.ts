// Provider credit accounting: the pure part of A-M14-05 (card Z08). Request costs, the rolling 31-day account caps and
// the per-consumer allocations from `/etc/bot/rpc-allocation.json`, the four ledger counts, and the month-end
// projection (logic 3). The SQLite ledger that persists the entries is `ledger.ts`; the consumer-side block reservation
// is `meter.ts`.
//
// Rules (SPEC-A A-M14-05 logic 2, supervisor rulings Z0D rounds 3-8):
// - one ledger per provider ACCOUNT (not per key), checked before every send; every request sent counts, whatever its
//   result (success, error, timeout, 429);
// - caps are rolling 31-day sums, at most 50% of the documented monthly allowance (Chainstack 1.5M of 3M RU [VF-10];
//   Helius 5M of Developer's 10M credits [LD-27]); no billing-date assumption;
// - the allocation file splits each account cap between consumers (engine, sentinel, signer); the shares never add up
//   to more than the cap, else every process refuses to start (`E_ALLOCATION_EXCEEDS_CAP`).
// Projection: projected = used this UTC month + (use in the last 24 h ÷ 24) × hours left in the month; at or above
// `rpc.burn.alert_bps` (default 8,000 = 80%) of the documented allowance the provider leaves P1-P4 (A-M14-02 step 6).
// The billing month is assumed to be the UTC calendar month (UNVERIFIED per provider; the spec's conservative reading).
import type { Result, UnixMs } from '@bot/types';
import type { ProviderConfig } from './types.ts';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** Rolling window of every account cap (SPEC-A A-M14-05 logic 2: "rolling 31-day sums"). */
export const ROLLING_WINDOW_MS = 31 * DAY_MS;
/** Owner rule (2026-10-06): a cap is at most half of the documented monthly allowance. */
export const MAX_CAP_SHARE_BPS = 5_000;
/** `rpc.reserve_block_units` ceiling (SPEC-A A-M14-05 config: ≤ 1,000). */
export const MAX_BLOCK_UNITS = 1_000;

export type Metering = NonNullable<ProviderConfig['metering']>;

/** Units one request of `method` costs: the method's listed cost, else 1 (Chainstack 1 RU a call [VF-10]; Helius standard 1 [LD-28]). */
export function unitsFor(metering: Metering, method: string): number {
  return Object.hasOwn(metering.methodCost, method) ? metering.methodCost[method] as number : 1;
}

/** Start of the UTC calendar month holding `atMs`. */
export function monthStartUtc(atMs: UnixMs): UnixMs {
  const d = new Date(atMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
/** Start of the next UTC calendar month after the one holding `atMs`. */
export function nextMonthStartUtc(atMs: UnixMs): UnixMs {
  const d = new Date(atMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
/** `YYYY-MM` of the UTC month holding `atMs` (counters are keyed by it, so a clock jump never merges two months). */
export function monthKeyUtc(atMs: UnixMs): string {
  return new Date(atMs).toISOString().slice(0, 7);
}

/** Logic 3: used + rate over the last 24 h × hours left in the UTC month. */
export function projectMonthEnd(usedThisMonth: number, usedLast24h: number, nowMs: UnixMs): number {
  const hoursLeft = (nextMonthStartUtc(nowMs) - nowMs) / HOUR_MS;
  return usedThisMonth + (usedLast24h / 24) * hoursLeft;
}

/** True when the projection is at or above `alertBps` of the documented monthly allowance. */
export function projectedOver(projected: number, monthlyAllowance: number, alertBps: number): boolean {
  return projected * 10_000 >= monthlyAllowance * alertBps;
}

/** One provider account's cap and this process's share of it, in the provider's units. */
export interface AccountCap { provider: string; accountCap: number; consumerCap: number }

export interface CreditAllocationFile {
  /** Per provider label, per consumer: units of the rolling 31-day cap, or `"rest"` (the cap less every other share). */
  credits: Readonly<Record<string, Readonly<Record<string, number | 'rest'>>>>;
}

export interface AllocationProblem { code: 'E_ALLOCATION_EXCEEDS_CAP' | 'E_CONFIG'; provider: string; message: string }

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Validates the credit part of the allocation file against the account caps and returns this consumer's caps.
 * `caps` maps each metered provider label to its rolling 31-day account cap (already checked ≤ 50% of the plan by
 * `checkAccountCap`). A metered provider with no line for this consumer gets a consumer cap of 0 (it is never sent to).
 */
export function consumerCaps(raw: unknown, caps: ReadonlyMap<string, number>, consumer: string): Result<AccountCap[], { code: 'E_ALLOCATION'; problems: AllocationProblem[] }> {
  const problems: AllocationProblem[] = [];
  const credits = isRecord(raw) && isRecord(raw.credits) ? raw.credits : null;
  if (credits === null) return { ok: false, error: { code: 'E_ALLOCATION', problems: [{ code: 'E_CONFIG', provider: '*', message: 'the allocation file needs a "credits" object' }] } };
  for (const label of Object.keys(credits)) {
    if (!caps.has(label)) problems.push({ code: 'E_CONFIG', provider: label, message: 'credits listed for a provider with no account cap' });
  }
  const out: AccountCap[] = [];
  for (const [provider, accountCap] of caps) {
    const shares = credits[provider];
    if (shares === undefined) { out.push({ provider, accountCap, consumerCap: 0 }); continue; }
    if (!isRecord(shares)) { problems.push({ code: 'E_CONFIG', provider, message: 'credits must map consumer names to units' }); continue; }
    let fixed = 0;
    let rest: string | null = null;
    let bad = false;
    for (const [name, v] of Object.entries(shares)) {
      if (v === 'rest') {
        if (rest !== null) { problems.push({ code: 'E_CONFIG', provider, message: 'at most one consumer may take "rest"' }); bad = true; }
        rest = name;
      } else if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) {
        fixed += v;
      } else {
        problems.push({ code: 'E_CONFIG', provider, message: `the share of ${name} must be a whole number of units ≥ 0 or "rest"` });
        bad = true;
      }
    }
    if (bad) continue;
    if (fixed > accountCap) {
      problems.push({ code: 'E_ALLOCATION_EXCEEDS_CAP', provider, message: `shares add up to ${fixed}, above the account cap ${accountCap}` });
      continue;
    }
    const own = shares[consumer];
    const consumerCap = own === undefined ? 0 : own === 'rest' ? accountCap - fixed : own as number;
    out.push({ provider, accountCap, consumerCap });
  }
  return problems.length > 0 ? { ok: false, error: { code: 'E_ALLOCATION', problems } } : { ok: true, value: out };
}

/** A configured account cap must be a whole number from 1 to 50% of the documented monthly allowance (owner rule). */
export function checkAccountCap(cap: number, monthlyAllowance: number): string | null {
  if (!Number.isSafeInteger(cap) || cap < 1) return 'must be a whole number ≥ 1';
  if (cap * 10_000 > monthlyAllowance * MAX_CAP_SHARE_BPS) return `must be at most 50% of the documented ${monthlyAllowance} a month`;
  return null;
}

/** The four ledger counts (SPEC-A A-M14-05 logic 2 "Ledger counts"); every cap uses `attempts`. */
export interface LedgerCounts { attempts: number; ok: number; errors: number; timeouts: number }
export type Outcome = 'ok' | 'error' | 'timeout';
