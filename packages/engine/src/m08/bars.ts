// A-M08-01 15-second bar builder and the 60-second bars of A-M08-03 (card Z09; ARCH M08). Pure and single-threaded:
// no I/O, no clock of its own; `closeDue` is driven by the injected clock (wall in live, sim in replay).
//
// ONE RULE FOR LIVE AND REPLAY (rulings Z09-19 and Z09-32). The engine has no mode. It reads two event kinds, both
// recorded by M07:
// - snapshots: a snapshot whose price, effective depth and real vault equal the state carried in is "unchanged" and
//   adds nothing (live receives every poll, the recording keeps changed ones; both reduce to the same changes);
// - `poll_counts`: one per pool per 15-second base bar, stamped with that bar's close (start + 15,000 + grace) when
//   M07 wrote it on time, else with its later write time (src/recorder/queue.ts).
// A bar closes when the clock reaches start + duration + grace (`closedAtMs`), with no wait. Its `snapshots` count is,
// per 15-second window in it, that window's successful polls from its `poll_counts` record when the record was
// received by the bar's close, else the window's changed snapshots. So the same events at the same times give the same
// `bar.closed` events, live or replay, and no bar uses a count received after its close (leak rule). Live, the worker
// calls M07's tick(now) and then closeDue(now) with the same `now`; replay delivers every record with recvMs ≤ t
// before closeDue(t).
//
// Prices are `spotSolPerToken` from M04 (effective quote / base, decimals applied, truncated to 24 fractional digits),
// compared exactly as integers scaled by 10^24. Depth is the effective quote; flow is the change of the REAL quote vault
// (virtual changes such as a boost are excluded, C-19).
//
// A bar opens at the state carried in from before `startMs` (the last change seen), or at its first change when there
// is none (DECISIONS Z09-B1). Its flow is close real vault − carried real vault (consecutive changes telescope).
// Memory (ruling Z09-23): a pool with nothing open, no count pending and no event for `idleForgetMs` is forgotten.
//
// Restarts (ruling Z09-40, rule (a)): a restarted worker's engine starts cold (no carried state, nothing open). A
// replay does the same at each recorded `process_start` marker through `reset()` (see m08/replay.ts), so live and
// replay agree across a restart. A count received before its window has ended cannot be a real count (Z09-42): it is
// refused, counted and logged (`m08.poll_counts_early`).
import type { DecimalStr, Lamports, Pubkey, SignedLamports, UnixMs } from '@bot/types';

export const BAR_MS = 15_000;
export const BAR_1M_MS = 60_000;
const SCALE = 10n ** 24n;
const BPS = 10_000n;

export interface Bar {
  poolId: Pubkey; startMs: UnixMs; durationMs: 15_000 | 60_000;
  open: DecimalStr; high: DecimalStr; low: DecimalStr; close: DecimalStr;
  depthLamportsClose: Lamports; depthChangeBps: number; netQuoteFlowLamports: SignedLamports;
  snapshots: number; missing: number;
  /** NEW (rulings Z09-19 and Z09-32): the `bar.closed` event time, always start + duration + grace. */
  closedAtMs: UnixMs;
}

/** The fields of an M04 `PoolSnapshot` the bars read. */
export interface BarSnapshot {
  poolId: Pubkey; observedAtMs: UnixMs; spotSolPerToken: DecimalStr | null;
  effectiveQuoteLamports: bigint; realQuoteLamports: bigint;
}
/** M04's `PoolSnapshot` to `BarSnapshot` (any pool state with a real quote vault). */
export function barSnapshotOf(s: { pool: { poolId: Pubkey; observedAtMs: UnixMs; quoteReserveReal: bigint }; spotSolPerToken: DecimalStr | null; effectiveQuoteLamports: bigint }): BarSnapshot {
  return { poolId: s.pool.poolId, observedAtMs: s.pool.observedAtMs, spotSolPerToken: s.spotSolPerToken, effectiveQuoteLamports: s.effectiveQuoteLamports, realQuoteLamports: s.pool.quoteReserveReal };
}
/**
 * One M07 `poll_counts` record (one 15-second window). `receivedAtMs` is its M07 `recvMs`; the count is used only for a
 * bar whose close is at or after it (leak rule). A `skippedBars` record (a pause) is not a per-bar count and is ignored.
 */
export interface PollCountsIn { poolId: Pubkey; barStartMs: UnixMs; durationMs: number; successfulPolls: number; skippedBars?: number; receivedAtMs: UnixMs }

export interface BarConfig {
  durationMs: 15_000 | 60_000;
  /** `bars.close_grace_ms` (1,500; 0-5,000). */
  closeGraceMs: number;
  /** `bars.incomplete_missing_bps` (2,000; 0-5,000). */
  incompleteMissingBps: number;
  /** A pool with no event for this long and nothing pending is forgotten (bounded memory). */
  idleForgetMs: number;
}
export const BAR_DEFAULTS: BarConfig = { durationMs: 15_000, closeGraceMs: 1_500, incompleteMissingBps: 2_000, idleForgetMs: 600_000 };

export function checkBarConfig(c: BarConfig): string | null {
  if (c.durationMs !== 15_000 && c.durationMs !== 60_000) return 'bar duration must be 15,000 or 60,000 ms';
  if (!Number.isInteger(c.closeGraceMs) || c.closeGraceMs < 0 || c.closeGraceMs > 5_000) return 'bars.close_grace_ms must be 0-5,000';
  if (!Number.isInteger(c.incompleteMissingBps) || c.incompleteMissingBps < 0 || c.incompleteMissingBps > 5_000) return 'bars.incomplete_missing_bps must be 0-5,000';
  if (!Number.isInteger(c.idleForgetMs) || c.idleForgetMs < c.durationMs + c.closeGraceMs) return 'idleForgetMs must be at least one bar and its grace';
  return null;
}

/** Parses an M04 spot price (digits, optional point and up to 24 fractional digits) to an integer scaled by 10^24. */
export function parseSpot(s: DecimalStr): bigint | null {
  const m = /^(\d{1,40})(?:\.(\d{1,24}))?$/.exec(s);
  if (m === null) return null;
  return BigInt(m[1] as string) * SCALE + BigInt((m[2] ?? '').padEnd(24, '0'));
}
export function renderSpot(v: bigint): DecimalStr {
  const s = v.toString().padStart(25, '0');
  return `${s.slice(0, -24)}.${s.slice(-24)}`;
}

interface State { price: bigint; depth: bigint; real: bigint; atMs: number }
interface Open { open: State; first: State | null; high: bigint; low: bigint; close: State; changedBy: number[] }
interface PoolBars {
  carried: State | null;
  bars: Map<number, Open>;
  /** Bars up to and including this start are closed; the state at the end of the last changed one. */
  closedThrough: number; closedState: State | null;
  /** Successful polls per 15-second window start, from records received by the containing bar's close. */
  counts: Map<number, number>;
  lastEventMs: number;
  stopped: boolean;
}

export interface BarEngineStats { droppedLate: number; skippedDecimals: number; skippedMalformed: number; unchanged: number; forgotten: number; lateCounts: number; earlyCounts: number }
export interface BarEngine {
  onSnapshot(s: BarSnapshot, expectedIntervalMs: number): void;
  onPollCounts(r: PollCountsIn): void;
  closeDue(nowMs: UnixMs): Bar[];
  isComplete(b: Bar): boolean;
  /** Pool quarantined or closed: its bars stop (edge case 2); open bars are discarded. */
  stop(poolId: Pubkey): void;
  stats(): BarEngineStats;
  /** Pools held in memory (bounded-memory tests). */
  size(): number;
  /** A process restart in a replay (Z09-40): every pool starts cold, as a restarted worker's engine does. */
  reset(): void;
}
export interface BarLog { event(level: 'warn', code: 'm08.poll_counts_early', fields: Readonly<Record<string, unknown>>): void }

export function createBarEngine(cfg: BarConfig = BAR_DEFAULTS, log?: BarLog): BarEngine {
  const problem = checkBarConfig(cfg);
  if (problem !== null) throw { code: 'E_CONFIG', message: problem };
  const D = cfg.durationMs;
  const windows = D / BAR_MS;
  const pools = new Map<Pubkey, PoolBars>();
  const expected = new Map<Pubkey, number>();
  const stats: BarEngineStats = { droppedLate: 0, skippedDecimals: 0, skippedMalformed: 0, unchanged: 0, forgotten: 0, lateCounts: 0, earlyCounts: 0 };
  const barOf = (ms: number): number => Math.floor(ms / D) * D;
  const closeOf = (start: number): number => start + D + cfg.closeGraceMs;

  const poolOf = (id: Pubkey, nowMs: number): PoolBars => {
    let p = pools.get(id);
    if (p === undefined) {
      p = { carried: null, bars: new Map(), closedThrough: -Infinity, closedState: null, counts: new Map(), lastEventMs: nowMs, stopped: false };
      pools.set(id, p);
    }
    return p;
  };

  /** Called only with n ≥ 1: a bar with no snapshot is a gap and is never emitted (logic 5). */
  function emit(out: Bar[], poolId: Pubkey, startMs: number, b: Open, n: number): void {
    const exp = Math.max(1, Math.round(D / (expected.get(poolId) ?? 1_000)));
    const openDepth = b.open.depth;
    const depthChange = openDepth === 0n ? 0n : ((b.close.depth - openDepth) * BPS) / openDepth;   // toward zero
    const base = b.first ?? b.open;
    out.push({
      poolId, startMs: startMs as UnixMs, durationMs: D,
      open: renderSpot(b.open.price), high: renderSpot(b.high), low: renderSpot(b.low), close: renderSpot(b.close.price),
      depthLamportsClose: b.close.depth as Lamports, depthChangeBps: Number(depthChange),
      netQuoteFlowLamports: (b.close.real - base.real) as SignedLamports,
      snapshots: n, missing: Math.max(0, exp - n),
      closedAtMs: closeOf(startMs) as UnixMs,
    });
  }

  /** Closes one pool's due bars in time order; a bar with no change is built from the state carried in. */
  function closePool(out: Bar[], poolId: Pubkey, p: PoolBars, lastDue: number): void {
    const starts = new Set<number>();
    for (const k of p.bars.keys()) if (k <= lastDue) starts.add(k);
    for (const k of p.counts.keys()) if (barOf(k) <= lastDue) starts.add(barOf(k));
    for (const s of [...starts].sort((x, y) => x - y)) {
      const b = p.bars.get(s);
      let n = 0;
      for (let i = 0; i < windows; i++) {
        const w = s + i * BAR_MS;
        const changed = b?.changedBy[i] ?? 0;
        const c = p.counts.get(w);
        // A window's changed snapshots were all successful polls, so its count is at least that many.
        n += c === undefined ? changed : Math.max(c, changed);
        p.counts.delete(w);
      }
      if (b !== undefined) {
        p.closedState = b.close;
        emit(out, poolId, s, b, n);                                                    // n ≥ its changed snapshots ≥ 1
      } else if (p.closedState !== null && n > 0) {
        const c = p.closedState;
        emit(out, poolId, s, { open: c, first: c, high: c.price, low: c.price, close: c, changedBy: [] }, n);
      }
      p.bars.delete(s);
    }
    if (lastDue > p.closedThrough) p.closedThrough = lastDue;
  }

  return {
    onSnapshot(s, expectedIntervalMs) {
      const p = poolOf(s.poolId, s.observedAtMs);
      if (p.stopped) return;
      if (s.spotSolPerToken === null) { stats.skippedDecimals += 1; return; }
      const price = parseSpot(s.spotSolPerToken);
      if (price === null || price <= 0n || s.effectiveQuoteLamports < 0n || !Number.isSafeInteger(s.observedAtMs)) { stats.skippedMalformed += 1; return; }
      const startMs = barOf(s.observedAtMs);
      // Edge case 1: older than a closed bar or than the last change (late beyond grace) → dropped and counted.
      if (startMs <= p.closedThrough || (p.carried !== null && s.observedAtMs < p.carried.atMs)) { stats.droppedLate += 1; return; }
      if (Number.isFinite(expectedIntervalMs) && expectedIntervalMs > 0) expected.set(s.poolId, expectedIntervalMs);
      p.lastEventMs = s.observedAtMs;
      const c = p.carried;
      if (c !== null && c.price === price && c.depth === s.effectiveQuoteLamports && c.real === s.realQuoteLamports) { stats.unchanged += 1; return; }
      const st: State = { price, depth: s.effectiveQuoteLamports, real: s.realQuoteLamports, atMs: s.observedAtMs };
      let b = p.bars.get(startMs);
      if (b === undefined) {
        const open = c ?? st;
        b = { open, first: c, high: open.price, low: open.price, close: st, changedBy: new Array<number>(windows).fill(0) };
        p.bars.set(startMs, b);
      }
      if (st.price > b.high) b.high = st.price;
      if (st.price < b.low) b.low = st.price;
      b.close = st;
      const i = Math.floor((s.observedAtMs - startMs) / BAR_MS);
      b.changedBy[i] = (b.changedBy[i] as number) + 1;
      p.carried = st;
    },

    onPollCounts(r) {
      if (!Number.isSafeInteger(r.barStartMs) || r.barStartMs % BAR_MS !== 0 || r.durationMs !== BAR_MS || r.skippedBars !== undefined) return;
      if (!Number.isSafeInteger(r.successfulPolls) || r.successfulPolls < 0 || !Number.isSafeInteger(r.receivedAtMs)) return;
      // Z09-42: a count received before its window ended is not a count of that window.
      if (r.receivedAtMs < r.barStartMs + BAR_MS) {
        stats.earlyCounts += 1;
        log?.event('warn', 'm08.poll_counts_early', { pool: r.poolId, early_ms: r.barStartMs + BAR_MS - r.receivedAtMs });
        return;
      }
      const p = poolOf(r.poolId, r.barStartMs);
      const start = barOf(r.barStartMs);
      if (p.stopped) return;
      // Received after the bar's close, or for a bar already closed: never used, live or replay (leak rule).
      if (r.receivedAtMs > closeOf(start) || start <= p.closedThrough) { stats.lateCounts += 1; return; }
      p.lastEventMs = Math.max(p.lastEventMs, r.barStartMs + BAR_MS);
      p.counts.set(r.barStartMs, r.successfulPolls);
    },

    closeDue(nowMs) {
      const out: Bar[] = [];
      const lastDue = barOf(nowMs - cfg.closeGraceMs - D);                               // the newest start that may close
      for (const [poolId, p] of [...pools]) {
        if (!p.stopped) closePool(out, poolId, p, lastDue);
        // Bounded memory: nothing open, nothing pending and idle for long → forgotten (a later event starts afresh).
        if (!p.stopped && p.bars.size === 0 && p.counts.size === 0 && nowMs - p.lastEventMs >= cfg.idleForgetMs) {
          pools.delete(poolId);
          expected.delete(poolId);
          stats.forgotten += 1;
        }
      }
      // A pool closes each bar start once, so (startMs, poolId) is unique and never ties.
      out.sort((a, b) => a.closedAtMs - b.closedAtMs || a.startMs - b.startMs || (a.poolId < b.poolId ? -1 : 1));
      return out;
    },

    isComplete(b) {
      const expectedN = b.snapshots + b.missing;
      return expectedN > 0 && BigInt(b.missing) * BPS <= BigInt(cfg.incompleteMissingBps) * BigInt(expectedN);
    },

    stop(poolId) {
      const p = poolOf(poolId, 0);
      p.stopped = true;
      p.bars.clear();
      p.counts.clear();
    },

    stats: () => ({ ...stats }),
    size: () => pools.size,
    reset() {
      pools.clear();
      expected.clear();
    },
  };
}
