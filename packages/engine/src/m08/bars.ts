// A-M08-01 15-second bar builder and the 60-second bars of A-M08-03 (card Z09; ARCH M08). Pure and single-threaded:
// no I/O, no clock of its own; `closeDue` is driven by the injected clock (wall in live, sim in replay), so live,
// paper, backtest and replay give the same bars.
//
// Prices are `spotSolPerToken` from M04 (effective quote / base, decimals applied, truncated to 24 fractional digits),
// compared exactly as integers scaled by 10^24. Depth is the effective quote; flow is the change of the REAL quote vault
// (virtual changes such as a boost are excluded, C-19).
//
// Builder reading (DECISIONS Z09-B1), so live and replay are identical in OHLC, depth and flow: a bar opens at the pool
// state carried in from before `startMs` (the last snapshot seen, whatever bar it was in), or at the bar's first
// snapshot when none was seen before. The recorder writes changed snapshots only, so a replay cannot tell whether an
// unchanged poll came before a bar's first change; the carried state is what every such poll returned, so this open
// is the state at the bar's start in both modes. A bar's flow is close real vault − carried real vault (the sum of
// consecutive changes from the previous bar's last snapshot, which telescopes).
//
// Snapshot counts (logic 4): live counts the snapshots received; replay counts from `poll_counts`: the minute's changed
// snapshots by their timestamps, plus its unchanged polls given to the bars below an even share of the minute
// (`spreadPolls`), so live and replay agree within ±1 per bar at a steady poll rate. A replay bar waits for its minute's
// `poll_counts` until `replayPollWaitMs` past the minute's end, then counts its changed snapshots only. A record with
// `skippedMinutes` (a pause) is not per-minute detail: those minutes count their changed snapshots only.
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
export interface PollCountsIn { poolId: Pubkey; minuteStartMs: UnixMs; successfulPolls: number; changedPolls?: number; skippedMinutes?: number }

export interface BarConfig {
  durationMs: 15_000 | 60_000;
  mode: 'live' | 'replay';
  /** `bars.close_grace_ms` (1,500; 0-5,000). */
  closeGraceMs: number;
  /** `bars.incomplete_missing_bps` (2,000; 0-5,000). */
  incompleteMissingBps: number;
  /** Replay only: how long past a minute's end a bar waits for that minute's `poll_counts`. */
  replayPollWaitMs: number;
}
export const BAR_DEFAULTS: BarConfig = { durationMs: 15_000, mode: 'live', closeGraceMs: 1_500, incompleteMissingBps: 2_000, replayPollWaitMs: 120_000 };

export function checkBarConfig(c: BarConfig): string | null {
  if (c.durationMs !== 15_000 && c.durationMs !== 60_000) return 'bar duration must be 15,000 or 60,000 ms';
  if (!Number.isInteger(c.closeGraceMs) || c.closeGraceMs < 0 || c.closeGraceMs > 5_000) return 'bars.close_grace_ms must be 0-5,000';
  if (!Number.isInteger(c.incompleteMissingBps) || c.incompleteMissingBps < 0 || c.incompleteMissingBps > 5_000) return 'bars.incomplete_missing_bps must be 0-5,000';
  if (!Number.isInteger(c.replayPollWaitMs) || c.replayPollWaitMs < 0) return 'replayPollWaitMs must be an integer >= 0';
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
interface Open { startMs: number; open: State; first: State | null; high: bigint; low: bigint; close: State; received: number }
interface PoolBars {
  /** The newest state seen (the open of the next bar). */
  carried: State | null;
  bars: Map<number, Open>;
  /** The newest bar start a snapshot fell in (late snapshots before it are dropped). */
  lastStartMs: number;
  /** Bars up to and including this start are closed; the state at the end of that bar. */
  closedThrough: number; closedState: State | null;
  /** Replay: changed snapshots per bar start, kept until the bar's minute is closed. */
  changed: Map<number, number>;
  /** Replay: successful polls per minute (null: a pause, changed snapshots only). */
  polls: Map<number, number | null>;
  stopped: boolean;
}

export interface BarEngineStats { droppedLate: number; skippedDecimals: number; skippedMalformed: number }
export interface BarEngine {
  onSnapshot(s: BarSnapshot, expectedIntervalMs: number): void;
  onPollCounts(r: PollCountsIn): void;
  closeDue(nowMs: UnixMs): Bar[];
  isComplete(b: Bar): boolean;
  /** Pool quarantined or closed: its bars stop (edge case 2); open bars are discarded. */
  stop(poolId: Pubkey): void;
  stats(): BarEngineStats;
}

export function createBarEngine(cfg: BarConfig = BAR_DEFAULTS): BarEngine {
  const problem = checkBarConfig(cfg);
  if (problem !== null) throw { code: 'E_CONFIG', message: problem };
  const D = cfg.durationMs;
  const perMinute = MINUTE_MS / D;
  const pools = new Map<Pubkey, PoolBars>();
  const expected = new Map<Pubkey, number>();
  const stats: BarEngineStats = { droppedLate: 0, skippedDecimals: 0, skippedMalformed: 0 };
  const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

  const poolOf = (id: Pubkey): PoolBars => {
    let p = pools.get(id);
    if (p === undefined) {
      p = { carried: null, bars: new Map(), lastStartMs: -Infinity, closedThrough: -Infinity, closedState: null, changed: new Map(), polls: new Map(), stopped: false };
      pools.set(id, p);
    }
    return p;
  };

  /** Replay snapshot count of the bar at `startMs`, or 'wait' while its minute's poll_counts may still come. */
  function replayCount(p: PoolBars, startMs: number, nowMs: number): number | 'wait' {
    const minute = minuteOf(startMs);
    const m = p.polls.get(minute);
    const own = p.changed.get(startMs) ?? 0;
    if (m === undefined) return nowMs < minute + MINUTE_MS + cfg.replayPollWaitMs ? 'wait' : own;
    if (m === null) return own;
    return spreadPolls(m, Array.from({ length: perMinute }, (_, i) => p.changed.get(minute + i * D) ?? 0))[(startMs - minute) / D] as number;
  }

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
    });
  }

  /** Closes one pool's bars due at `nowMs`, in time order. */
  function closePool(out: Bar[], poolId: Pubkey, p: PoolBars, nowMs: number): void {
    const lastDue = Math.floor((nowMs - cfg.closeGraceMs - D) / D) * D;                 // the newest start that may close
    if (cfg.mode === 'live') {
      for (const startMs of [...p.bars.keys()].sort((a, b) => a - b)) {
        if (startMs > lastDue) break;
        const b = p.bars.get(startMs) as Open;
        p.bars.delete(startMs);
        p.closedThrough = startMs;
        p.closedState = b.close;
        emit(out, poolId, startMs, b, b.received);                                    // a bucket holds ≥ 1 snapshot
      }
      return;
    }
    // Replay: walk every bar start in order; a bar without a changed snapshot is built from the state carried in.
    let s = p.closedThrough === -Infinity ? Math.min(...p.bars.keys(), ...p.polls.keys()) : p.closedThrough + D;
    while (Number.isFinite(s) && s <= lastDue) {
      const n = replayCount(p, s, nowMs);
      if (n === 'wait') break;
      const b = p.bars.get(s);
      if (b !== undefined) {
        p.bars.delete(s);
        p.closedState = b.close;
        emit(out, poolId, s, b, n);                                                   // n ≥ its changed snapshots ≥ 1
      } else if (p.closedState !== null && n > 0) {
        const c = p.closedState;
        emit(out, poolId, s, { startMs: s, open: c, first: c, high: c.price, low: c.price, close: c, received: 0 }, n);
      }
      p.closedThrough = s;
      p.changed.delete(s);
      if (s + D === minuteOf(s) + MINUTE_MS) p.polls.delete(minuteOf(s));
      // Skip a run of bars that can hold nothing: no changed snapshot and no polls recorded for their minutes.
      let next = s + D;
      if (!p.bars.has(next) && !p.polls.has(minuteOf(next)) && nowMs >= minuteOf(next) + MINUTE_MS + cfg.replayPollWaitMs) {
        const known = [...p.bars.keys(), ...p.polls.keys()].filter((k) => k > s);
        const jump = known.length === 0 ? lastDue + D : Math.min(...known);
        // Every key is a multiple of 15 s above `s`, so target ≥ next; the bars skipped hold no bucket (no changed entry).
        next = Math.min(jump, lastDue + D);
        p.closedThrough = next - D;
      }
      s = next;
    }
  }

  return {
    onSnapshot(s, expectedIntervalMs) {
      const p = poolOf(s.poolId);
      if (p.stopped) return;
      if (s.spotSolPerToken === null) { stats.skippedDecimals += 1; return; }
      const price = parseSpot(s.spotSolPerToken);
      if (price === null || price <= 0n || s.effectiveQuoteLamports < 0n || !Number.isSafeInteger(s.observedAtMs)) { stats.skippedMalformed += 1; return; }
      const startMs = Math.floor(s.observedAtMs / D) * D;
      // Edge case 1: older than the pool's open bar or than a closed one (late beyond grace) → dropped and counted.
      if (startMs < p.lastStartMs || startMs <= p.closedThrough || (p.carried !== null && s.observedAtMs < p.carried.atMs)) { stats.droppedLate += 1; return; }
      if (Number.isFinite(expectedIntervalMs) && expectedIntervalMs > 0) expected.set(s.poolId, expectedIntervalMs);
      const st: State = { price, depth: s.effectiveQuoteLamports, real: s.realQuoteLamports, atMs: s.observedAtMs };
      let b = p.bars.get(startMs);
      if (b === undefined) {
        const open = p.carried ?? st;
        b = { startMs, open, first: p.carried, high: open.price, low: open.price, close: st, received: 0 };
        p.bars.set(startMs, b);
      }
      if (st.price > b.high) b.high = st.price;
      if (st.price < b.low) b.low = st.price;
      b.close = st;
      b.received += 1;
      p.changed.set(startMs, (p.changed.get(startMs) ?? 0) + 1);
      p.lastStartMs = startMs;
      p.carried = st;
    },

    onPollCounts(r) {
      if (cfg.mode !== 'replay') return;
      if (!Number.isSafeInteger(r.minuteStartMs) || r.minuteStartMs % MINUTE_MS !== 0 || !Number.isSafeInteger(r.successfulPolls) || r.successfulPolls < 0) return;
      const p = poolOf(r.poolId);
      if (p.stopped || r.minuteStartMs + MINUTE_MS - D <= p.closedThrough) return;
      const span = r.skippedMinutes ?? 1;
      if (!Number.isSafeInteger(span) || span < 1) return;
      if (span > 1) for (let i = 0; i < span; i++) p.polls.set(r.minuteStartMs + i * MINUTE_MS, null);
      else p.polls.set(r.minuteStartMs, r.successfulPolls);
    },

    closeDue(nowMs) {
      const out: Bar[] = [];
      for (const [poolId, p] of pools) if (!p.stopped) closePool(out, poolId, p, nowMs);
      // A pool closes each bar start once, so (startMs, poolId) is unique and never ties.
      out.sort((a, b) => a.startMs - b.startMs || (a.poolId < b.poolId ? -1 : 1));
      return out;
    },

    isComplete(b) {
      const expectedN = b.snapshots + b.missing;
      return expectedN > 0 && BigInt(b.missing) * BPS <= BigInt(cfg.incompleteMissingBps) * BigInt(expectedN);
    },

    stop(poolId) {
      const p = poolOf(poolId);
      p.stopped = true;
      p.bars.clear();
      p.changed.clear();
      p.polls.clear();
    },

    stats: () => ({ ...stats }),
  };
}
