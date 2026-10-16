// A-M05-03 daily universe manifest and the A-24 count (card Z09; ARCH 3.4). At 00:00 UTC the record of every pool
// eligible during the day (with why) and every eviction (with why) is written through M07 stream `universe_manifest`
// and hashed; M07 puts the hash into the day's `CoverageReport.universeManifestSha256`, so every replay builds the
// universe-at-the-time from it. The manifest is built from the candidate transitions alone (M24 `candidate_event`),
// so a day missed while the engine was down is rebuilt from the database on restart with `late: true`.
//
// Eligible means any state from `eligible` on (eligible, watched, stale, signalled, in_position, cooldown), plus a pool
// evicted for the watch budget, staleness or degraded reads (it still passed the prefilter and is "eligible again
// later", ARCH 7.5); a pool evicted because its re-screen failed is not (DECISIONS Z09-U5). In Phase 0 eligibility is prefilter-only (`phase0_unscreened`),
// so `a24.eligibleCount` is an UPPER BOUND and says so (`a24.upperBound`). `canonicalityUnknownCount` is 0 by
// construction while every candidate comes from an on-chain-verified canonical pool (A-M03-02).
//
// NEW fields beside SPEC-A's `UniverseManifestFile` (card Z09; supervisor review): `late`; `a24.upperBound`;
// `crossCheck.otherDexPairs` and `crossCheck.knownPoolsUnderOtherDex` with `status` `dex_id_mismatch` (rulings Z08-9,
// Z08-30, SPEC-A C-95); `migrationCoverage` (A-M03-02's PumpPortal gap, its definition of done).
import { createHash } from 'node:crypto';
import { canonicalJson, type CandidateState, type Pubkey, type UnixMs } from '@bot/types';

const DAY = 86_400_000;
const ELIGIBLE: ReadonlySet<CandidateState> = new Set<CandidateState>(['eligible', 'watched', 'stale', 'signalled', 'in_position', 'cooldown']);
const NOT_ELIGIBLE_EVICTIONS: ReadonlySet<string> = new Set(['cooldown_rescreen_failed']);

export interface ManifestEvent { poolId: Pubkey; mint: Pubkey; from: CandidateState | null; to: CandidateState; reason: string; atMs: number }
export interface ManifestCrossCheck {
  poolsOnlyInVendor: number; otherDexPairs: number; knownPoolsUnderOtherDex: number;
  status: 'ok' | 'partial' | 'unavailable' | 'dex_id_mismatch';
}
export interface UniverseManifestFile {
  manifestVersion: 1; dayUtc: string; generatedAtMs: UnixMs; late: boolean;
  enumerationCoverage: 'full' | 'migrations_since_start' | 'none';
  eligible: Array<{ poolId: Pubkey; mint: Pubkey; venue: string; firstEligibleAtMs: UnixMs; lastEligibleAtMs: UnixMs; reason: string }>;
  evicted: Array<{ poolId: Pubkey; atMs: UnixMs; reason: string; tailUntilMs: UnixMs | null }>;
  a24: { eligibleCount: number; canonicalityUnknownCount: number; maxSimultaneous: number; upperBound: boolean };
  crossCheck: ManifestCrossCheck;
  migrationCoverage: { chainMigrations: number; seenByPumpPortal: number; gapBps: number };
  sha256: string;
}

/** Code-point order (locale-free, deterministic). */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function dayBounds(dayUtc: string): { startMs: number; endMs: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) throw { code: 'E_INVALID_ARG', message: 'dayUtc must be YYYY-MM-DD' };
  const startMs = Date.parse(`${dayUtc}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 10) !== dayUtc) throw { code: 'E_INVALID_ARG', message: 'not a calendar day' };
  return { startMs, endMs: startMs + DAY };
}

export interface ManifestInput {
  dayUtc: string;
  /** Every candidate transition up to the day's end, in time order (earlier days set the state carried in). */
  events: readonly ManifestEvent[];
  /** Watchlist evictions that are not transitions (tail capacity) and the tail end of each eviction (A-M05-02). */
  watchlistEvictions?: ReadonlyArray<{ poolId: Pubkey; atMs: number; reason: string; tailUntilMs: number | null }>;
  crossCheck: ManifestCrossCheck;
  migrationCoverage: { chainMigrations: number; seenByPumpPortal: number; gapBps: number };
  enumerationCoverage?: UniverseManifestFile['enumerationCoverage'];
  generatedAtMs: number;
  late: boolean;
  /** Phase 0: eligibility is prefilter-only (`phase0_unscreened`), so the A-24 count is an upper bound. */
  prefilterOnly: boolean;
  venueOf?: (poolId: Pubkey) => string;
}

/** The SHA-256 of the canonical JSON without `sha256`. */
export function manifestSha256(m: Omit<UniverseManifestFile, 'sha256'>): string {
  return createHash('sha256').update(canonicalJson(m), 'utf8').digest('hex');
}

export function buildUniverseManifest(i: ManifestInput): UniverseManifestFile {
  const { startMs, endMs } = dayBounds(i.dayUtc);
  const venueOf = i.venueOf ?? (() => 'pumpswap');
  const state = new Map<Pubkey, { in: boolean; sinceMs: number; mint: Pubkey; reason: string }>();
  const spans = new Map<Pubkey, { mint: Pubkey; first: number; last: number; reason: string }>();
  const evicted: UniverseManifestFile['evicted'] = [];
  const edges: Array<[number, number]> = [];
  const tailOf = new Map<string, number | null>();
  for (const e of i.watchlistEvictions ?? []) tailOf.set(`${e.poolId}@${e.atMs}`, e.tailUntilMs);

  const touch = (p: Pubkey, from: number, to: number, mint: Pubkey, reason: string): void => {
    const a = Math.max(from, startMs), b = Math.min(to, endMs);
    if (b < a || a >= endMs || b < startMs) return;
    const s = spans.get(p);
    if (s === undefined) spans.set(p, { mint, first: a, last: b, reason });
    else { s.last = Math.max(s.last, b); s.first = Math.min(s.first, a); s.reason = reason; }
    edges.push([a, 1], [b, -1]);
  };
  for (let k = 1; k < i.events.length; k++) {
    if ((i.events[k] as ManifestEvent).atMs < (i.events[k - 1] as ManifestEvent).atMs) throw { code: 'E_ORDER', message: 'manifest events must be in time order' };
  }
  for (const e of i.events) {
    if (e.atMs >= endMs) break;
    const cur = state.get(e.poolId);
    const enter = ELIGIBLE.has(e.to) || (e.to === 'evicted' && !NOT_ELIGIBLE_EVICTIONS.has(e.reason));
    if (cur?.in === true && !enter) touch(e.poolId, cur.sinceMs, e.atMs, cur.mint, cur.reason);
    if (enter) {
      const reason = e.to === 'eligible' ? e.reason : cur?.reason ?? e.reason;
      state.set(e.poolId, { in: true, sinceMs: cur?.in === true ? cur.sinceMs : e.atMs, mint: e.mint, reason });
    } else {
      state.set(e.poolId, { in: false, sinceMs: e.atMs, mint: e.mint, reason: cur?.reason ?? e.reason });
    }
    if (e.to === 'evicted' && e.atMs >= startMs) {
      evicted.push({ poolId: e.poolId, atMs: e.atMs as UnixMs, reason: e.reason, tailUntilMs: (tailOf.get(`${e.poolId}@${e.atMs}`) ?? null) as UnixMs | null });
    }
  }
  // Still eligible at the day's end: the span runs to its last millisecond.
  for (const [p, s] of state) if (s.in) touch(p, s.sinceMs, endMs - 1, s.mint, s.reason);
  for (const e of i.watchlistEvictions ?? []) {
    if (e.reason === 'tail_capacity' && e.atMs >= startMs && e.atMs < endMs) evicted.push({ poolId: e.poolId, atMs: e.atMs as UnixMs, reason: e.reason, tailUntilMs: null });
  }
  // Peak concurrency: ends before starts at the same instant (a hand-over is not two at once).
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of edges) { cur += d; if (cur > peak) peak = cur; }
  const eligible = [...spans].map(([poolId, s]) => ({
    poolId, mint: s.mint, venue: venueOf(poolId), firstEligibleAtMs: s.first as UnixMs, lastEligibleAtMs: s.last as UnixMs, reason: s.reason,
  })).sort((a, b) => a.firstEligibleAtMs - b.firstEligibleAtMs || cmp(a.poolId, b.poolId));
  evicted.sort((a, b) => a.atMs - b.atMs || cmp(a.poolId, b.poolId) || cmp(a.reason, b.reason));
  const body: Omit<UniverseManifestFile, 'sha256'> = {
    manifestVersion: 1, dayUtc: i.dayUtc, generatedAtMs: i.generatedAtMs as UnixMs, late: i.late,
    enumerationCoverage: i.enumerationCoverage ?? 'migrations_since_start',
    eligible, evicted,
    a24: { eligibleCount: eligible.length, canonicalityUnknownCount: 0, maxSimultaneous: peak, upperBound: i.prefilterOnly },
    crossCheck: { ...i.crossCheck }, migrationCoverage: { ...i.migrationCoverage },
  };
  return { ...body, sha256: manifestSha256(body) };
}

/** Writes a day's manifest once (immutable once hashed); a second write of the same day is refused. */
export interface ManifestSink { has(dayUtc: string): boolean; write(m: UniverseManifestFile): void }
export function writeManifestOnce(sink: ManifestSink, m: UniverseManifestFile): { ok: true; sha256: string } | { ok: false; code: 'E_EXISTS' } {
  if (sink.has(m.dayUtc)) return { ok: false, code: 'E_EXISTS' };
  sink.write(m);
  return { ok: true, sha256: m.sha256 };
}

/**
 * Z08-9 / SPEC-A C-95: the day's cross-check runs on the base mints and pools of the migrations A-M03-02 verified in
 * the last 24 h; vendor data never adds a pool (it only fills the manifest's `crossCheck`).
 */
export async function dailyCrossCheck(
  migrations: { recentMigrations(windowMs: number): Array<{ mint: Pubkey; pool: Pubkey }> },
  check: { crossCheck(mints: readonly Pubkey[], knownPools: ReadonlySet<Pubkey>): Promise<{ poolsOnlyInVendor: unknown[]; otherDexPairs: number; knownPoolsUnderOtherDex: number; status: ManifestCrossCheck['status'] }> },
): Promise<ManifestCrossCheck> {
  const recent = migrations.recentMigrations(DAY);
  if (recent.length === 0) return { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' };
  const r = await check.crossCheck(recent.map((m) => m.mint), new Set(recent.map((m) => m.pool)));
  return { poolsOnlyInVendor: r.poolsOnlyInVendor.length, otherDexPairs: r.otherDexPairs, knownPoolsUnderOtherDex: r.knownPoolsUnderOtherDex, status: r.status };
}

/**
 * M24 `candidate_event` rows → manifest events in time order. Rows of one pool that share a millisecond are put in
 * chain order (each `from` is the previous `to`), since the table keeps no sequence within a millisecond.
 */
export function eventsFromRows(rows: ReadonlyArray<{ poolId: Pubkey; mint: Pubkey; fromState: CandidateState | null; toState: CandidateState; reason: string; at: number }>): ManifestEvent[] {
  const byPool = new Map<Pubkey, ManifestEvent[]>();
  for (const r of rows) {
    const e: ManifestEvent = { poolId: r.poolId, mint: r.mint, from: r.fromState, to: r.toState, reason: r.reason, atMs: r.at };
    const list = byPool.get(r.poolId);
    if (list === undefined) byPool.set(r.poolId, [e]); else list.push(e);
  }
  const out: ManifestEvent[] = [];
  for (const list of byPool.values()) {
    list.sort((a, b) => a.atMs - b.atMs);
    let state: CandidateState | null = null;
    for (let k = 0; k < list.length;) {
      let end = k;
      while (end < list.length && (list[end] as ManifestEvent).atMs === (list[k] as ManifestEvent).atMs) end += 1;
      const group = list.slice(k, end);
      while (group.length > 0) {
        const at = group.findIndex((e) => e.from === state);
        const [e] = group.splice(at === -1 ? 0 : at, 1) as [ManifestEvent];
        out.push(e);
        state = e.to;
      }
      k = end;
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);                                       // stable: each pool keeps its chain order
}
