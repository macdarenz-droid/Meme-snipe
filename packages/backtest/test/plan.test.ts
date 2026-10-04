// The study plan under the review consensus (2026-10-04): a fixed holdout end E, an observation-only tail, practice
// days strictly before the holdout, B2–B4 hard boundaries and B5 a decoder boundary that may fall inside the holdout.
import { describe, expect, it } from 'vitest';
import { STUDY_CONFIG, type StudyConfig } from '../src/strategy/config.ts';
import { holdoutDaysOf, practiceDays, regimeOf, studyPlan } from '../src/study/plan.ts';

const HOLD_TAIL = 6 * 3_600_000;

describe('study plan', () => {
  it('fixes the holdout from 09-22 to the entry cutoff E = 10-20 plus one observation day, whatever was downloaded', () => {
    const hold = holdoutDaysOf(STUDY_CONFIG);
    expect(hold[0]).toBe('2026-09-22');
    expect(hold.at(-1)).toBe('2026-10-20');
    expect(hold).toHaveLength(29);
    expect(hold).toContain('2026-10-02');
    const practice = practiceDays(STUDY_CONFIG);
    expect(practice[0]).toBe('2026-08-03');
    expect(practice.at(-1)).toBe('2026-09-21');
    expect(practice.some((d) => hold.includes(d))).toBe(false);
  });

  it('stops holdout entries at E and starts them after the embargo; walk-forward trades finish before the holdout', () => {
    const p = studyPlan(STUDY_CONFIG, HOLD_TAIL);
    expect(p.holdout.entriesTo).toBe(Date.parse('2026-10-20T00:00:00Z'));
    expect(p.holdout.entriesFrom).toBe(Date.parse('2026-09-22T00:00:00Z') + STUDY_CONFIG.embargoMs);
    expect(p.holdout.toDay).toBe('2026-10-20');
    expect(p.walkForward.entriesTo).toBe(Date.parse('2026-09-22T00:00:00Z') - HOLD_TAIL);
    expect(p.walkForward.folds.flatMap((f) => f.days)).toEqual(practiceDays(STUDY_CONFIG));
  });

  it('allows the decoder boundary B5 inside the holdout and refuses a market boundary there', () => {
    expect(() => studyPlan(STUDY_CONFIG, HOLD_TAIL)).not.toThrow();
    const market: StudyConfig = { ...STUDY_CONFIG, regimes: STUDY_CONFIG.regimes.map((b) => (b.label === 'B5' ? { ...b, market: true } : b)) };
    expect(() => studyPlan(market, HOLD_TAIL)).toThrow(/market regime boundary B5 falls inside the holdout/);
  });

  it('refuses a cutoff that leaves no room for the last hold before the data ends', () => {
    const tight: StudyConfig = { ...STUDY_CONFIG, holdout: { ...STUDY_CONFIG.holdout, tailDays: 0 } };
    expect(() => studyPlan(tight, HOLD_TAIL)).toThrow(/entry cutoff/);
  });

  it('tags B5 only on reporting lines: purging and G1 regimes see market boundaries alone', () => {
    const afterB5 = Date.parse('2026-10-05T00:00:00Z');
    expect(regimeOf(STUDY_CONFIG, afterB5)).toBe('B4');
    expect(regimeOf(STUDY_CONFIG, afterB5, true)).toBe('B5');
  });
});
