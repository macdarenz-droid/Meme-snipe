// A-M08-01 15-second bar builder and the 60-second bars of A-M08-03 (card Z09; ARCH M08). Pure and single-threaded:
// no I/O, no clock of its own; `closeDue` is driven by the injected clock (wall in live, sim in replay).
//
// ONE RULE FOR LIVE AND REPLAY (ruling Z09-19; DECISIONS Z09-B4). The engine has no mode. It reads two event kinds, both
// recorded by M07 and both delivered live by the recorder queue at the moment it writes them:
// - snapshots: a snapshot whose price, effective depth and real vault equal the state carried in is "unchanged" and
//   adds nothing (live receives every poll, the recording keeps changed ones; both reduce to the same changes);
// - `poll_counts`: one per pool per minute, written at the minute tick.
// A bar closes when the clock is past start + duration + grace AND its minute's `poll_counts` is known, or the clock is
// `pollWaitMs` past the minute's end (then it counts its changed snapshots only). Its `snapshots` count is its changed
// snapshots plus the minute's unchanged polls spread by `spreadPolls`. So the same events at the same times give the same
// `bar.closed` events at the same times, live or replay, and no bar ever uses an event its run had not received by then
// (leak rule). The cost: a bar closes at about its minute's end plus the poll_counts delay (≤ 75 s after its start at
// 1 Hz polling), not 16.5 s after it; strategies read bars that late in every mode.
//
// Prices are `spotSolPerToken` from M04 (effective quote / base, decimals applied, truncated to 24 fractional digits),
// compared exactly as integers scaled by 10^24. Depth is the effective quote; flow is the change of the REAL quote vault
// (virtual changes such as a boost are excluded, C-19).
//
// A bar opens at the state carried in from before `startMs` (the last change seen), or at its first change when there
// is none (DECISIONS Z09-B1). Its flow is close real vault − carried real vault (consecutive changes telescope).
// Memory (ruling Z09-23): a pool with nothing open, no minute pending and no event for `idleForgetMs` is forgotten.
import type { DecimalStr, Lamports, Pubkey, SignedLamports, UnixMs } from '@bot/types';

export const BAR_MS = 15_000;
export const BAR_1M_MS = 60_000;
const MINUTE_MS = 60_000;
const SCALE = 10n ** 24n;
const BPS = 10_000n;

export interface Bar {
  poolId: Pubkey; startMs: UnixMs; durationMs: 15_000 | 60_000;
  open: DecimalStr; high: DecimalStr; low: DecimalStr; close: DecimalStr;
  depthLamportsClose: Lamports; depthChangeBps: number; netQuoteFlowLamports: SignedLamports;
  snapshots: number; missing: number;
  /**
   * NEW (ruling Z09-19): the `bar.closed` event time, the first moment its close rule held: start + duration + grace,
   * or the receipt of its minute's poll_counts, or the end of the wait, whichever is latest. It does not depend on how
   * often `closeDue` is called, so live and replay give the same value.
   */
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
 * `receivedAtMs`: when the record reached the engine (its M07 `recvMs`; live: the queue's write time). Required: a count
 * is used only by a `closeDue` at or after it (leak rule, Z09-19).
 */
export interface PollCountsIn { poolId: Pubkey; minuteStartMs: UnixMs; successfulPolls: number; changedPolls?: number; skippedMinutes?: number; receivedAtMs: UnixMs }

export interface BarConfig {
  durationMs: 15_000 | 60_000;
  /** `bars.close_grace_ms` (1,500; 0-5,000). */
  closeGraceMs: number;
  /** `bars.incomplete_missing_bps` (2,000; 0-5,000). */
  incompleteMissingBps: number;
  /** How long past a minute's end a bar waits for that minute's `poll_counts`. */
  pollWaitMs: number;
  /** A pool with no event for this long and nothing pending is forgotten (bounded memory). */
  idleForgetMs: number;
}
export const BAR_DEFAULTS: BarConfig = { durationMs: 15_000, closeGraceMs: 1_500, incompleteMissingBps: 2_000, pollWaitMs: 120_000, idleForgetMs: 600_000 };

export function checkBarConfig(c: BarConfig): string | null {
  if (c.durationMs !== 15_000 && c.durationMs !== 60_000) return 'bar duration must be 15,000 or 60,000 ms';
  if (!Number.isInteger(c.closeGraceMs) || c.closeGraceMs < 0 || c.closeGraceMs > 5_000) return 'bars.close_grace_ms must be 0-5,000';
  if (!Number.isInteger(c.incompleteMissingBps) || c.incompleteMissingBps < 0 || c.incompleteMissingBps > 5_000) return 'bars.incomplete_missing_bps must be 0-5,000';
  if (!Number.isInteger(c.pollWaitMs) || c.pollWaitMs < 0) return 'pollWaitMs must be an integer >= 0';
  if (!Number.isInteger(c.idleForgetMs) || c.idleForgetMs < c.pollWaitMs + MINUTE_MS) return 'idleForgetMs must be at least pollWaitMs + 60,000';
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

/**
 * Logic 4, replay: a minute's `successful` polls over its bars. Each bar keeps its changed snapshots; the unchanged polls
 * go one at a time to the bar furthest below an even share of the minute (the earliest on a tie), so a steady poll
 * rate gives every bar its even share, as live counts it (DECISIONS Z09-B2).
 */
export function spreadPolls(successful: number, changed: readonly number[]): number[] {
  const n = changed.length;
  const counts = [...changed];
  const target = changed.map((_, i) => Math.floor(successful / n) + (i < successful % n ? 1 : 0));
  let unchanged = Math.max(0, successful - changed.reduce((a, b) => a + b, 0));
  while (unchanged > 0) {
    let best = 0;
    for (let i = 1; i < n; i++) if ((target[i] as number) - (counts[i] as number) > (target[best] as number) - (counts[best] as number)) best = i;
    counts[best] = (counts[best] as number) + 1;
    unchanged -= 1;
  }
  return counts;
}

interface State { price: bigint; depth: bigint; real: bigint; atMs: number }
interface Open { open: State; first: State | null; high: bigint; low: bigint; close: State; changed: number }
interface PoolBars {
  carried: State | null;
  bars: Map<number, Open>;
  /** Bars up to and including this start are closed; the state at the end of that bar. */
  closedThrough: number; closedState: State | null;
  /** Changed snapshots per bar start, kept until the bar's minute is closed (the spread reads the whole minute). */
  changed: Map<number, number>;
  /** Successful polls per minute (null: a pause, changed snapshots only) and when they were received. */
  polls: Map<number, { n: number | null; atMs: number }>;
  lastEventMs: number;
  stopped: boolean;
}

export interface BarEngineStats { droppedLate: number; skippedDecimals: number; skippedMalformed: number; unchanged: number; forgotten: number }
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
}

export function createBarEngine(cfg: BarConfig = BAR_DEFAULTS): BarEngine {
  const problem = checkBarConfig(cfg);
  if (problem !== null) throw { code: 'E_CONFIG', message: problem };
  const D = cfg.durationMs;
  const perMinute = MINUTE_MS / D;
  const pools = new Map<Pubkey, PoolBars>();
  const expected = new Map<Pubkey, number>();
  const stats: BarEngineStats = { droppedLate: 0, skippedDecimals: 0, skippedMalformed: 0, unchanged: 0, forgotten: 0 };
  const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

  const poolOf = (id: Pubkey, nowMs: number): PoolBars => {
    let p = pools.get(id);
    if (p === undefined) {
      p = { carried: null, bars: new Map(), closedThrough: -Infinity, closedState: null, changed: new Map(), polls: new Map(), lastEventMs: nowMs, stopped: false };
      pools.set(id, p);
    }
    return p;
  };

  /** Snapshot count of the bar at `startMs` and when it became known, or 'wait' while its minute's poll_counts may come. */
  function count(p: PoolBars, startMs: number, nowMs: number): { n: number; knownAtMs: number } | 'wait' {
    const minute = minuteOf(startMs);
    const m = p.polls.get(minute);
    const own = p.changed.get(startMs) ?? 0;
    const deadline = minute + MINUTE_MS + cfg.pollWaitMs;
    if (m === undefined || m.atMs > nowMs) return nowMs < deadline ? 'wait' : { n: own, knownAtMs: deadline };
    if (m.n === null) return { n: own, knownAtMs: m.atMs };
    return { n: spreadPolls(m.n, Array.from({ length: perMinute }, (_, i) => p.changed.get(minute + i * D) ?? 0))[(startMs - minute) / D] as number, knownAtMs: m.atMs };
  }

  /** Called only with n ≥ 1: a bar with no snapshot is a gap and is never emitted (logic 5). */
  function emit(out: Bar[], poolId: Pubkey, startMs: number, b: Open, n: number, knownAtMs: number): void {
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
      closedAtMs: Math.max(startMs + D + cfg.closeGraceMs, knownAtMs) as UnixMs,
    });
  }

  /** Closes one pool's due bars in time order; a bar with no change is built from the state carried in. */
  function closePool(out: Bar[], poolId: Pubkey, p: PoolBars, nowMs: number): void {
    const lastDue = Math.floor((nowMs - cfg.closeGraceMs - D) / D) * D;                 // the newest start that may close
    let s = p.closedThrough === -Infinity ? Math.min(...p.bars.keys(), ...p.polls.keys()) : p.closedThrough + D;
    while (Number.isFinite(s) && s <= lastDue) {
      const k = count(p, s, nowMs);
      if (k === 'wait') break;
      const b = p.bars.get(s);
      if (b !== undefined) {
        p.closedState = b.close;
        emit(out, poolId, s, b, k.n, k.knownAtMs);                                    // n ≥ its changed snapshots ≥ 1
      } else if (p.closedState !== null && k.n > 0) {
        const c = p.closedState;
        emit(out, poolId, s, { open: c, first: c, high: c.price, low: c.price, close: c, changed: 0 }, k.n, k.knownAtMs);
      }
      p.bars.delete(s);
      p.closedThrough = s;
      if (s + D === minuteOf(s) + MINUTE_MS) {
        p.polls.delete(minuteOf(s));
        for (let i = 0; i < perMinute; i++) p.changed.delete(minuteOf(s) + i * D);
      }
      // Skip a run of bars that can hold nothing: no change and no polls recorded for their minutes.
      let next = s + D;
      if (!p.bars.has(next) && !p.polls.has(minuteOf(next)) && nowMs >= minuteOf(next) + MINUTE_MS + cfg.pollWaitMs) {
        const known = [...p.bars.keys(), ...p.polls.keys()].filter((k) => k > s);
        const jump = known.length === 0 ? lastDue + D : Math.min(...known);
        // Every key is a multiple of 15 s above `s`, so the jump target is ≥ next.
        next = Math.min(jump, lastDue + D);
        p.closedThrough = next - D;
        for (const k of [...p.changed.keys()]) if (k < minuteOf(next)) p.changed.delete(k);
      }
      s = next;
    }
  }

  return {
    onSnapshot(s, expectedIntervalMs) {
      const p = poolOf(s.poolId, s.observedAtMs);
      if (p.stopped) return;
      if (s.spotSolPerToken === null) { stats.skippedDecimals += 1; return; }
      const price = parseSpot(s.spotSolPerToken);
      if (price === null || price <= 0n || s.effectiveQuoteLamports < 0n || !Number.isSafeInteger(s.observedAtMs)) { stats.skippedMalformed += 1; return; }
      const startMs = Math.floor(s.observedAtMs / D) * D;
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
        b = { open, first: c, high: open.price, low: open.price, close: st, changed: 0 };
        p.bars.set(startMs, b);
      }
      if (st.price > b.high) b.high = st.price;
      if (st.price < b.low) b.low = st.price;
      b.close = st;
      b.changed += 1;
      p.changed.set(startMs, (p.changed.get(startMs) ?? 0) + 1);
      p.carried = st;
    },

    onPollCounts(r) {
      if (!Number.isSafeInteger(r.minuteStartMs) || r.minuteStartMs % MINUTE_MS !== 0 || !Number.isSafeInteger(r.successfulPolls) || r.successfulPolls < 0) return;
      const span = r.skippedMinutes ?? 1;
      if (!Number.isSafeInteger(span) || span < 1 || !Number.isSafeInteger(r.receivedAtMs)) return;
      const p = poolOf(r.poolId, r.minuteStartMs);
      if (p.stopped || r.minuteStartMs + MINUTE_MS - D <= p.closedThrough) return;
      p.lastEventMs = Math.max(p.lastEventMs, r.minuteStartMs + MINUTE_MS * span);
      const atMs = r.receivedAtMs;
      if (span > 1) for (let i = 0; i < span; i++) p.polls.set(r.minuteStartMs + i * MINUTE_MS, { n: null, atMs });
      else p.polls.set(r.minuteStartMs, { n: r.successfulPolls, atMs });
    },

    closeDue(nowMs) {
      const out: Bar[] = [];
      for (const [poolId, p] of [...pools]) {
        if (!p.stopped) closePool(out, poolId, p, nowMs);
        // Bounded memory: nothing open, nothing pending and idle for long → forgotten (a later event starts afresh).
        if (!p.stopped && p.bars.size === 0 && p.polls.size === 0 && p.changed.size === 0 && nowMs - p.lastEventMs >= cfg.idleForgetMs) {
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
      p.polls.clear();
      p.changed.clear();
    },

    stats: () => ({ ...stats }),
    size: () => pools.size,
  };
}
