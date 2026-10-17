// A-M08-03 `bar_1m` persistence and OHLC aggregation for VM-10 (card Z09; ARCH 15, CB-15). M08 is the only writer of
// `bar_1m`. The 60 s bars come from the same snapshots as the 15 s bars (`createBarEngine({ durationMs: 60_000 })`);
// 15 s bars are never served. Once a minute every closed 1-minute bar is written in one transaction; a failed write
// keeps the bars in memory for up to 10 minutes and retries, then drops them, reported as a gap (an M07-style gap).
// Aggregation for 5m/1h/1d happens on read; prices become doubles only in the response (VM-10 display exception).
import type { Pubkey, UnixMs } from '@bot/types';
import type { Db, ReaderHandle } from '../m24/db.ts';
import { MutableRepo } from '../m24/repos.ts';
import { parseSpot, type Bar } from './bars.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;
export const RESOLUTION_MS = { '1m': MINUTE, '5m': 5 * MINUTE, '1h': 60 * MINUTE, '1d': DAY } as const;
export type Resolution = keyof typeof RESOLUTION_MS;
/** In-memory hold on write failure (logic edge case). */
export const HOLD_MS = 10 * MINUTE;
/** `bars.bar_1m_retention_days` (90; 7-365). */
export const RETENTION_DEFAULT_DAYS = 90;

export interface Ohlc { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; gaps: Array<{ fromMs: number; toMs: number; reason: string }> }
export interface StoreGap { poolId: Pubkey; fromMs: UnixMs; toMs: UnixMs; reason: 'write_failed' }

const repo = new MutableRepo('bar_1m');

/** Display-only double (VM-10): finite and |v| < 2^53. */
function display(v: number): number {
  if (!Number.isFinite(v) || Math.abs(v) >= 2 ** 53) throw { code: 'E_DISPLAY_RANGE' };
  return v;
}
const priceNum = (s: string): number => {
  if (parseSpot(s) === null) throw { code: 'E_DECIMAL' };
  return display(Number(s));                                                         // the nearest double to the exact decimal
};

export interface BarStore {
  /** Adds closed 60 s bars (others are refused: 15 s bars are never stored). */
  add(bars: readonly Bar[]): void;
  /** Writes every held bar in one transaction; on failure keeps them up to 10 minutes, then drops them as gaps. */
  flush(nowMs: UnixMs): { written: number; dropped: StoreGap[] };
  /**
   * Deletes rows older than the retention (logic 5, daily). SW-32: with `limit`, at most that many in one transaction,
   * found along the `bar_1m_minute` index (migration 0003); the caller repeats while it returns `limit`.
   */
  purge(nowMs: UnixMs, limit?: number): number;
  ohlc(h: ReaderHandle, poolId: Pubkey, resolution: Resolution, fromMs: UnixMs, toMs: UnixMs,
    coverageGaps?: ReadonlyArray<{ fromMs: number; toMs: number; reason: string }>): Ohlc;
  held(): number;
}

export function createBarStore(db: Db, o: { retentionDays?: number; log?: { event(level: 'error', code: string, fields: Readonly<Record<string, unknown>>): void } } = {}): BarStore {
  const days = o.retentionDays ?? RETENTION_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 7 || days > 365) throw { code: 'E_CONFIG', message: 'bars.bar_1m_retention_days must be 7-365' };
  let pending: Array<{ bar: Bar; heldSinceMs: number }> = [];
  return {
    add(bars) {
      for (const b of bars) {
        if (b.durationMs !== MINUTE) throw { code: 'E_NOT_1M' };
        pending.push({ bar: b, heldSinceMs: Number.NaN });
      }
    },
    flush(nowMs) {
      for (const p of pending) if (Number.isNaN(p.heldSinceMs)) p.heldSinceMs = nowMs;
      if (pending.length === 0) return { written: 0, dropped: [] };
      try {
        db.withTx((tx) => {
          for (const { bar: b } of pending) {
            repo.upsert(tx, {
              poolId: b.poolId, minute: b.startMs, open: b.open, high: b.high, low: b.low, close: b.close,
              closeDepthLamports: b.depthLamportsClose, snapshots: b.snapshots, createdAt: nowMs,
            });
          }
        });
        const written = pending.length;
        pending = [];
        return { written, dropped: [] };
      } catch (e) {
        o.log?.event('error', 'm08.bar_1m_write_failed', { error_code: String((e as { code?: unknown }).code ?? 'unknown'), held: pending.length });
        const keep = pending.filter((p) => nowMs - p.heldSinceMs < HOLD_MS);
        const dropped = pending.filter((p) => nowMs - p.heldSinceMs >= HOLD_MS)
          .map((p) => ({ poolId: p.bar.poolId, fromMs: p.bar.startMs, toMs: (p.bar.startMs + MINUTE) as UnixMs, reason: 'write_failed' as const }));
        pending = keep;
        return { written: 0, dropped };
      }
    },
    purge(nowMs, limit) {
      if (limit === undefined) return db.withTx((tx) => tx.run('DELETE FROM "bar_1m" WHERE "minute" < ?', nowMs - days * DAY).changes);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('m08: purge limit must be a positive integer');
      return db.withTx((tx) => tx.run('DELETE FROM "bar_1m" WHERE rowid IN (SELECT rowid FROM "bar_1m" WHERE "minute" < ? LIMIT ?)', nowMs - days * DAY, limit).changes);
    },
    held: () => pending.length,
    ohlc(h, poolId, resolution, fromMs, toMs, coverageGaps = []) {
      const step = RESOLUTION_MS[resolution];
      if (!(Number.isSafeInteger(fromMs) && Number.isSafeInteger(toMs) && toMs > fromMs)) throw { code: 'E_INVALID_ARG' };
      const from = Math.floor(fromMs / MINUTE) * MINUTE;
      const rows = h.all('SELECT "minute", "open", "high", "low", "close" FROM "bar_1m" WHERE "pool_id" = ? AND "minute" >= ? AND "minute" < ? ORDER BY "minute"',
        poolId, from, toMs);
      const out: Ohlc = { t: [], o: [], h: [], l: [], c: [], gaps: [] };
      let bucket: { t: number; o: bigint; h: bigint; l: bigint; c: bigint; os: string; hs: string; ls: string; cs: string } | null = null;
      const push = (): void => {
        if (bucket === null) return;
        out.t.push(display(bucket.t)); out.o.push(priceNum(bucket.os)); out.h.push(priceNum(bucket.hs)); out.l.push(priceNum(bucket.ls)); out.c.push(priceNum(bucket.cs));
      };
      let expect = from;
      for (const r of rows) {
        const m = Number(r.minute);
        if (m > expect) out.gaps.push({ fromMs: expect, toMs: m, reason: 'no_bar' });
        expect = m + MINUTE;
        const t = Math.floor(m / step) * step;
        const [os, hs, ls, cs] = [r.open, r.high, r.low, r.close].map(String) as [string, string, string, string];
        const [ov, hv, lv, cv] = [os, hs, ls, cs].map((s) => parseSpot(s) as bigint) as [bigint, bigint, bigint, bigint];
        if (bucket === null || bucket.t !== t) {
          push();
          bucket = { t, o: ov, h: hv, l: lv, c: cv, os, hs, ls, cs };
        } else {
          if (hv > bucket.h) { bucket.h = hv; bucket.hs = hs; }
          if (lv < bucket.l) { bucket.l = lv; bucket.ls = ls; }
          bucket.c = cv; bucket.cs = cs;
        }
      }
      push();
      if (expect < toMs) out.gaps.push({ fromMs: expect, toMs, reason: 'no_bar' });
      for (const g of coverageGaps) if (g.toMs > from && g.fromMs < toMs) out.gaps.push({ fromMs: g.fromMs, toMs: g.toMs, reason: g.reason });
      out.gaps.sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
      return out;
    },
  };
}
