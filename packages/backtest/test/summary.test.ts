// G3's holdout summary: the fields as the G3 builder defined them, the lower bound at the composite level, and the
// reject mix counted once per never-entered candidate by the first typed reason of its last abstention.
import { describe, expect, it } from 'vitest';
import type { LogRecord } from '../../core/src/engine/index.ts';
import { VETO_COMPOSITE_LEVEL } from '../../core/src/stats/index.ts';
import type { ScoredTrade } from '../src/study/score.ts';
import { holdoutSummary, rejectMixOf, RETURN_CAP, typedReason } from '../src/study/summary.ts';

const decision = (reasons: string[]): LogRecord => ({ type: 'decision', seq: 0, at: { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: 0 }, eventId: 'e', inputs: [], action: null, reasons, result: 'abstained', effects: [] }) as unknown as LogRecord;

describe('holdout summary', () => {
  it('types every abstention kind as gate:code', () => {
    expect(typedReason(['reject', 'U2', 'm', 'H11:stale', 'not evaluated: H1'])).toBe('H11:stale');
    expect(typedReason(['risk refused', 'U2', 'm', 'R7:daily_loss'])).toBe('R7:daily_loss');
    expect(typedReason(['regime off', 'U2', 'm', 'unknown:curve-volume'])).toBe('regime:unknown');
    expect(typedReason(['no entry', 'U2', 'm', 'stop too-wide: distance 9 above 2000 bps'])).toBe('stop:too-wide');
    expect(typedReason(['no entry', 'U2', 'm', 'book busy: another entry'])).toBe('worker:book-busy');
    expect(typedReason(['no entry', 'U2', 'm', 'pool state unknown'])).toBe('worker:market-data');
    expect(typedReason(['no setup', 'U2', 'm', 'no higher low'])).toBe('setup:no-setup');
    expect(typedReason(['not evaluated', 'U2', 'm', 'holder scan budget spent'])).toBe('worker:not-evaluated');
    expect(typedReason(['candidate', 'U2', 'm', 'check 1'])).toBeNull();
  });

  it('counts each never-entered candidate once, by its last abstention; entered ones and other tags are left out', () => {
    const records = [
      decision(['reject', 'U2', 'a', 'H11:stale']), decision(['no setup', 'U2', 'a', 'x']),
      decision(['reject', 'U2', 'b', 'H14:prior-rug']),
      decision(['reject', 'U2', 'c', 'H11:stale']), decision(['enter', 'U2', 'c', 'notional 1']),
      decision(['reject', 'U1', 'd', 'H9:excluded-window']),
    ];
    expect(rejectMixOf(records, 'U2')).toEqual({ 'H14:prior-rug': 1, 'setup:no-setup': 1 });
  });

  it('gives n, mean, sd, the severe share and the lower bound at G3\'s composite level', () => {
    const t = (day: string, rNet: number, ySevere = false) => ({ day, rNet, ySevere }) as ScoredTrade;
    const trades = Array.from({ length: 30 }, (_, k) => t(`2026-10-${String(2 + (k % 10)).padStart(2, '0')}`, k % 5 === 0 ? -0.6 : 0.1, k % 5 === 0));
    const s = holdoutSummary(trades, 120, 672, { 'H11:stale': 7 }, 1, 200);
    expect(s.holdout.n).toBe(30);
    expect(s.holdout.mean).toBeCloseTo((6 * -0.6 + 24 * 0.1) / 30, 12);
    expect(s.severeRate).toBeCloseTo(0.2, 12);
    expect(s.lower.level).toBe(VETO_COMPOSITE_LEVEL);
    expect(s.lower.value).toBeLessThan(s.holdout.mean);
    expect(s).toMatchObject({ candidates: { count: 120, hours: 672 }, rejectMix: { 'H11:stale': 7 }, returnCap: RETURN_CAP });
    expect(RETURN_CAP).toBeGreaterThan(0);
    expect(RETURN_CAP).toBeLessThanOrEqual(3);
    expect(() => holdoutSummary(trades.slice(0, 1), 1, 1, {}, 1)).toThrow(RangeError);
  });
});
