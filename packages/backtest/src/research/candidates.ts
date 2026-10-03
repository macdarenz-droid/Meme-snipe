// Decision points and universe filters for signal research (RES-3, docs/research/signals.md §2). The driver releases
// rows to the tracker in chain order and takes each decision right after the first block at or after its due time,
// so a decision sees the state at the end of that slot and nothing later. Features are recorded; outcomes are not
// known here (outcome.ts scores them in a separate stage).
import type { Policy } from '../../../core/src/config/index.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import { type OffchainSeries, seriesReleases } from '../dataset/offchain.ts';
import { guardRows, isPracticeDay, melbourneDay, type PracticeWindow, regimeAt, wallMs } from './practice.ts';
import { type Features, type PoolInfo, SignalTracker } from './tracker.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type Universe = 'U1' | 'U2';

export interface Candidate {
  /** `<universe>:<mint>:<decision ms>`. */
  readonly id: string;
  readonly universe: Universe;
  readonly mint: string;
  readonly pool: string;
  /** Melbourne day of the decision. */
  readonly day: string;
  /** Platform regime in force at the decision (ARCHITECTURE.md §6.5). */
  readonly regime: string;
  readonly decisionMs: number;
  readonly decisionSlot: bigint;
  /** SOL/USD as of the decision (for the notional). */
  readonly solUsd: number;
  readonly features: Features;
  /** Passed every base filter of its universe. Rejected candidates are kept and labelled too (§13.1). */
  readonly eligible: boolean;
  readonly rejects: readonly string[];
}

export interface DriveOptions {
  readonly window: PracticeWindow;
  readonly policy: Policy;
  readonly solUsd: (ms: number) => number | null;
  /** U2 decision ages after migration (fixed in the plan: 60, 120, 180 min). */
  readonly u2AgesMs: readonly number[];
  /** U1 grid step (4 h) and the pool age range (24 h to 14 days). */
  readonly u1GridMs: number;
  readonly u1MinAgeMs: number;
  readonly u1MaxAgeMs: number;
  /** U1 market cap floor, SOL (1,470). */
  readonly u1MinMcapSol: number;
  /** Outcome window after a decision (horizon plus the exit ladder): a decision whose window reaches the wall is purged. */
  readonly outcomeWindowMs: number;
}

export const PLAN_DRIVE = {
  u2AgesMs: [60 * MIN, 120 * MIN, 180 * MIN],
  u1GridMs: 4 * HOUR,
  u1MinAgeMs: DAY,
  u1MaxAgeMs: 14 * DAY,
  u1MinMcapSol: 1470,
  outcomeWindowMs: 120 * MIN + 30 * MIN,
} as const;

export interface DriveResult {
  readonly candidates: Candidate[];
  /** Decisions dropped because their outcome window would reach the wall. */
  readonly purged: number;
  /** Decisions on lead-in days (history only, never candidates). */
  readonly leadIn: number;
  readonly unquotableSwaps: number;
  readonly lastSlot: bigint;
}

/** SOL/USD as usable at a moment (a fixed bar is usable one bar after its close; offchain.ts), or null. */
export const solUsdAsOf = (s: OffchainSeries, maxAgeMs: number): ((ms: number) => number | null) => {
  const rel = seriesReleases(s);
  return (ms) => {
    let lo = 0;
    let hi = rel.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rel[mid]!.at <= ms) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return null;
    const r = rel[lo - 1]!;
    return ms - r.at > maxAgeMs ? null : Number(r.bar.close);
  };
};

const usd = (micro: bigint): number => Number(micro) / 1e6;

/** Base filters (proxies of GATE-1, signals.md §2). Returns the reasons a candidate fails; empty when eligible. */
export const baseRejects = (t: SignalTracker, p: PoolInfo, u: Universe, nowMs: number, solUsd: number, o: DriveOptions): string[] => {
  const g = o.policy.gates;
  const out: string[] = [];
  const live = t.liveState(p.pool);
  if (live.effectiveQuote === null || live.price === null) return ['pool state unknown'];
  const liqUsd = (Number(live.effectiveQuote) / 1e9) * solUsd;
  const sizeFloor = usd(o.policy.capital.minNotional) * o.policy.liquidity.floorNotionalMultiple;
  const floor = Math.max(usd(o.policy.liquidity.floorUsd), sizeFloor, u === 'U1' ? usd(o.policy.liquidity.u1FloorUsd) : 0);
  if (liqUsd < floor) out.push('H8 below liquidity floor');
  const spike = t.candleSpike(p, nowMs, g.candleWindowMs);
  if (spike === null || spike * 10_000 > g.candleSpikeBps) out.push('H11 candle spike');
  if (p.migratedAtMs === null || nowMs - p.migratedAtMs < g.excludedWindowMs) out.push('H10 excluded window');
  if (u === 'U2') {
    if (p.migrationQuote === null || p.migrationQuote < g.dustPoolMinAtMigration) out.push('H8 dust at migration');
    const m = t.mints.get(p.mint);
    if (m === undefined || p.migratedAtMs === null) out.push('H9 creation unknown');
    else if (p.migratedAtMs - m.createdAtMs < g.instantGraduationMinMs) out.push('H9 instant graduation');
    const p5 = t.price5(p, nowMs);
    if (p5 === null || p.migrationPrice === null) out.push('H11 price at +5 min unknown');
    else if (p5 * 10_000 > p.migrationPrice * (10_000 + g.chaseMaxAboveMigrationBps)) out.push('H11 chase above migration price');
  } else {
    const mcapSol = (live.price * Number(live.supply)) / 1e9;
    if (mcapSol < o.u1MinMcapSol) out.push('U1 market cap below floor');
  }
  return out;
};

const member = (p: PoolInfo): boolean => p.canonical && p.mayhem === false && p.migratedAtMs !== null;

interface Due {
  readonly at: number;
  readonly pool: string;
}

export const collectCandidates = (rows: Iterable<DatasetRow>, o: DriveOptions): DriveResult => {
  const t = new SignalTracker({ solUsd: o.solUsd });
  const wall = wallMs(o.window);
  const candidates: Candidate[] = [];
  const u2: Due[] = [];
  let u2At = 0;
  let nextGrid: number | null = null;
  let purged = 0;
  let leadIn = 0;
  let lastPrune = 0;

  const decide = (u: Universe, p: PoolInfo, nowMs: number, slot: bigint): void => {
    const day = melbourneDay(nowMs);
    if (!isPracticeDay(o.window, day)) {
      if (day < o.window.decisionFrom) leadIn++;
      return;
    }
    // Purged: an outcome window that would reach the wall, or a hold that would cross a regime boundary (BT-2's rule).
    if (nowMs + o.outcomeWindowMs >= wall || regimeAt(o.window, nowMs) !== regimeAt(o.window, nowMs + o.outcomeWindowMs)) {
      purged++;
      return;
    }
    const px = o.solUsd(nowMs);
    const rejects = px === null ? ['H16 SOL/USD unknown'] : baseRejects(t, p, u, nowMs, px, o);
    candidates.push({
      id: `${u}:${p.mint}:${nowMs}`, universe: u, mint: p.mint, pool: p.pool, day, regime: regimeAt(o.window, nowMs), decisionMs: nowMs, decisionSlot: slot,
      solUsd: px ?? 0, features: t.features(p.pool, nowMs, slot), eligible: rejects.length === 0, rejects,
    });
  };

  for (const row of guardRows(o.window, rows)) {
    const migPool = row.kind === 'event' && row.event === 'CompletePumpAmmMigrationEvent' ? row.fields['pool'] ?? '' : null;
    const known = migPool === null || t.pools.has(migPool);
    t.push(row);
    if (!known) {
      const p = t.pools.get(migPool!);
      if (p !== undefined && member(p) && t.isSolQuote(p)) for (const a of o.u2AgesMs) u2.push({ at: p.migratedAtMs! + a, pool: p.pool });
    }
    if (row.kind !== 'block') continue;
    const now = row.blockTime * 1000;
    // Migrations arrive in time order and the ages are fixed, so due times only need sorting within the pending tail.
    if (u2.length - u2At > 1) {
      const tail = u2.splice(u2At).sort((a, b) => a.at - b.at || (a.pool < b.pool ? -1 : 1));
      u2.push(...tail);
    }
    while (u2At < u2.length && u2[u2At]!.at <= now) {
      const p = t.pools.get(u2[u2At]!.pool);
      if (p !== undefined) decide('U2', p, now, row.slot);
      u2At++;
    }
    if (u2At > 4096) {
      u2.splice(0, u2At);
      u2At = 0;
    }
    if (nextGrid === null) nextGrid = Math.ceil(now / o.u1GridMs) * o.u1GridMs;
    if (now >= nextGrid) {
      const pools = [...t.trackedPools()].filter((p) => member(p) && t.isSolQuote(p) && now - p.migratedAtMs! >= o.u1MinAgeMs && now - p.migratedAtMs! <= o.u1MaxAgeMs);
      pools.sort((a, b) => (a.pool < b.pool ? -1 : 1));
      for (const p of pools) decide('U1', p, now, row.slot);
      while (nextGrid <= now) nextGrid += o.u1GridMs;
    }
    if (now - lastPrune >= HOUR) {
      t.prune(now, o.u1MaxAgeMs + DAY);
      lastPrune = now;
    }
  }
  return { candidates, purged, leadIn, unquotableSwaps: t.unquotable, lastSlot: t.slot };
};
