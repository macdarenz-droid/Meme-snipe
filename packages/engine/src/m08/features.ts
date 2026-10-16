// A-M08-02 features: robust z-score, rolling median, MAD scale, dump flag, basket return (card Z09; ARCH M08, ARCH 3.3,
// [ST-V08], clarifications C-18, C-20, C-21). Built from COMPLETE 15 s bars only; an incomplete or missing bar is a gap
// and breaks the return chain. Log returns use the close as a double for features only, never for accounting.
//
// "Now" is the newest bar start fed (`onBar`), the same for every pool: a pool whose newest complete bar is older has no
// `close_now` and its z-score and basket term are null. Bars close in time order (A-M08-01), so this is deterministic
// in live and replay. Every reduction runs in a fixed order (time, then pool id) with no parallelism, so two runs on
// the same bars are bitwise equal.
//
// Builder reading (DECISIONS Z09-B3): the median of an even count is the lower middle element for closes (logic 4) and
// for the MAD (median of returns and of absolute deviations), so every feature uses one deterministic median.
import type { Bar } from './bars.ts';
import { parseSpot } from './bars.ts';
import type { DecimalStr, Features, Pubkey } from '@bot/types';

export const MAD_CONSISTENCY = 0.67449;
const BAR = 15_000;
const SIX_H = 21_600_000;

export interface FeatureConfig {
  /** `features.robust_z_scaling`: frozen at pre-registration (C-20). */
  robustZScaling: 'sqrt_time' | 'none';
  /** `features.min_coverage_bps` (5,000). */
  minCoverageBps: number;
  /** `features.basket_min_pools` (3, 1-30). */
  basketMinPools: number;
  /** `features.median_window_ms` (21,600,000). */
  medianWindowMs: number;
  /** `features.dump_window_ms` (1,800,000). */
  dumpWindowMs: number;
}
export const FEATURE_DEFAULTS: FeatureConfig = { robustZScaling: 'sqrt_time', minCoverageBps: 5_000, basketMinPools: 3, medianWindowMs: SIX_H, dumpWindowMs: 1_800_000 };

export function checkFeatureConfig(c: FeatureConfig): string | null {
  if (c.robustZScaling !== 'sqrt_time' && c.robustZScaling !== 'none') return 'features.robust_z_scaling must be sqrt_time or none';
  if (!Number.isInteger(c.minCoverageBps) || c.minCoverageBps < 1 || c.minCoverageBps > 10_000) return 'features.min_coverage_bps must be 1-10,000';
  if (!Number.isInteger(c.basketMinPools) || c.basketMinPools < 1 || c.basketMinPools > 30) return 'features.basket_min_pools must be 1-30';
  for (const [k, v] of [['median_window_ms', c.medianWindowMs], ['dump_window_ms', c.dumpWindowMs]] as const) {
    if (!Number.isInteger(v) || v < BAR || v % BAR !== 0 || v > SIX_H) return `features.${k} must be a multiple of 15,000 ms up to 6 h`;
  }
  if (c.dumpWindowMs >= SIX_H) return 'features.dump_window_ms must be shorter than the 6 h baseline';
  return null;
}

/** `@bot/types` `Features` (ARCH M08, the strategy view) plus the owner side that feeds it. */
export interface FeatureEngine extends Features {
  onBar(b: Bar, complete: boolean): void;
  /** Pools that count in the basket (watched, not tail; ARCH M08). */
  setWatched(pools: Iterable<Pubkey>): void;
  /** Edge case 3: an evicted pool's windows are dropped; a re-watch restarts from the bars that come. */
  forget(poolId: Pubkey): void;
}

interface Pt { close: bigint; closeStr: DecimalStr; ln: number }

/** Lower-middle median of numbers (sorted copy; deterministic). */
export function lowerMedian(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] as number;
}

export function createFeatures(cfg: FeatureConfig = FEATURE_DEFAULTS): FeatureEngine {
  const problem = checkFeatureConfig(cfg);
  if (problem !== null) throw { code: 'E_CONFIG', message: problem };
  // Kept: the 6 h baseline plus the largest window, plus one bar for the first return.
  const retainMs = SIX_H + Math.max(cfg.medianWindowMs, SIX_H) + BAR;
  const pools = new Map<Pubkey, Map<number, Pt>>();
  let watched: Pubkey[] = [];
  let now = -Infinity;

  const at = (poolId: Pubkey, startMs: number): Pt | undefined => pools.get(poolId)?.get(startMs);
  /** 15 s log returns ending in (fromExcl, toIncl], in time order. */
  function returns(poolId: Pubkey, fromExcl: number, toIncl: number): number[] {
    const m = pools.get(poolId);
    if (m === undefined) return [];
    const out: number[] = [];
    for (let t = Math.floor(fromExcl / BAR) * BAR + BAR; t <= toIncl; t += BAR) {
      const a = m.get(t - BAR), b = m.get(t);
      if (a !== undefined && b !== undefined) out.push(b.ln - a.ln);
    }
    return out;
  }
  function scaleOf(rs: readonly number[], windowMs: number): number | null {
    const expected = windowMs / BAR;
    if (rs.length === 0 || rs.length * 10_000 < cfg.minCoverageBps * expected) return null;
    const med = lowerMedian(rs);
    const mad = lowerMedian(rs.map((r) => Math.abs(r - med)));
    return mad === 0 ? null : mad / MAD_CONSISTENCY;
  }
  const validWindow = (ms: number): boolean => Number.isInteger(ms) && ms >= BAR && ms % BAR === 0;

  const f: FeatureEngine = {
    onBar(b, complete) {
      if (b.durationMs !== BAR) return;
      if (b.startMs > now) now = b.startMs;
      if (!complete) return;
      const close = parseSpot(b.close);
      if (close === null || close <= 0n) return;                                    // edge case 1: price 0 → null features
      let m = pools.get(b.poolId);
      if (m === undefined) { m = new Map(); pools.set(b.poolId, m); }
      m.set(b.startMs, { close, closeStr: b.close, ln: Math.log(Number(close) / 1e24) });
      for (const t of m.keys()) { if (t > now - retainMs) break; m.delete(t); }   // insertion order is time order
    },
    setWatched(ps) { watched = [...new Set(ps)].sort(); },
    madScale(poolId, windowMs) {
      if (!validWindow(windowMs)) return null;
      return scaleOf(returns(poolId, now - windowMs, now), windowMs);
    },
    robustZ(poolId, lookbackMs) {
      if (!validWindow(lookbackMs)) return null;
      const a = at(poolId, now - lookbackMs), b = at(poolId, now);
      if (a === undefined || b === undefined) return null;
      const scale = f.madScale(poolId, SIX_H);
      if (scale === null) return null;
      const s = cfg.robustZScaling === 'sqrt_time' ? Math.sqrt(lookbackMs / BAR) : 1;
      return (b.ln - a.ln) / (scale * s);
    },
    rollingMedian(poolId, windowMs) {
      if (!validWindow(windowMs)) return null;
      const m = pools.get(poolId);
      if (m === undefined) return null;
      const xs: Pt[] = [];
      for (const [t, p] of m) if (t > now - windowMs && t <= now) xs.push(p);
      if (xs.length === 0) return null;
      xs.sort((x, y) => (x.close < y.close ? -1 : x.close > y.close ? 1 : 0));
      return (xs[Math.floor((xs.length - 1) / 2)] as Pt).closeStr;
    },
    dumpFlagState(poolId) {
      const baseline = returns(poolId, now - SIX_H, now - cfg.dumpWindowMs);
      const sigma = scaleOf(baseline, SIX_H - cfg.dumpWindowMs);
      if (sigma === null) return 'insufficient';
      return returns(poolId, now - cfg.dumpWindowMs, now).some((r) => r < -4 * sigma) ? 'dump' : 'clear';
    },
    dumpFlag: (poolId) => f.dumpFlagState(poolId) === 'dump',
    basketReturn(windowMs) {
      if (!validWindow(windowMs)) return null;
      let sum = 0, n = 0;
      for (const p of watched) {
        const a = at(p, now - windowMs), b = at(p, now);
        if (a === undefined || b === undefined) continue;
        sum += b.ln - a.ln;
        n += 1;
      }
      return n < cfg.basketMinPools ? null : sum / n;
    },
    forget(poolId) { pools.delete(poolId); },
  };
  return f;
}
