// Round 4 red team, paralysis hunt (coverage, caps, missing-day and warm-up rules). Every test here asserts the
// NON-paralysed behaviour and FAILS on integration commit cd4d7a6: each names one input that, alone, turns the regime
// gate off for every coin for a long time without a proven reason ("Discipline, not paralysis").
//   P-EXEC-STALE    exec-health is published every 10 s (worker EXEC_STATS_EVERY_MS) but read as an 'offchain' fact
//                   with the 2 s quote age: the regime is off ~80% of the time in a judged live run (regime.ts:200).
//   P-EXEC-ZERO     with owner limits set, zero attempts is "fewer than minAttempts" => red; paper attempts need entries,
//                   entries need the regime on: a deadlock that never clears (producer.ts:1300).
//   P-SURV-DAY      one 24 h stretch without a recorded graduate (a ~1 day outage) makes survival unknown for the next
//                   14 days: the median refuses instead of using the other 13 days (regime.ts:99-101).
//   P-DIAG-GRAD     under the S0 diagnostic survival is not judged, yet an old graduates snapshot still holds the current
//                   check back, so the regime turns off when no graduate resolved for 2 h (regime.ts:189).
import { describe, expect, it } from 'vitest';
import { OFF_CHAIN, type Moment } from '../../src/engine/index.ts';
import { DAY_MS, EXEC_HEALTH_KEY, GRADUATES_KEY, HOUR_MS, MINUTE_MS, evaluateRegime, survivalCondition } from '../../src/gates/index.ts';
import { RAW } from '../../src/facts/index.ts';
import { EXEC_HEALTH_KEY as EH } from '../../src/gates/facts.ts';
import { SLOT, SOL_USD_KEY as _S, T, contextOf, deps, passingFacts, solPoints, type Facts } from '../gates/world.ts';
import { SOL_USD_KEY } from '../../src/gates/index.ts';
import { FactWorld, OPTIONS, offchain } from '../facts/helpers.ts';

const at = (receivedAt: number, slot: bigint): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt });
const policy = deps('live').session.policy;

describe('round 4 paralysis: regime inputs', () => {
  it('P-EXEC-STALE: a green exec-health fact 5 s old (published every 10 s) does not turn the regime off', () => {
    const f: Facts = new Map(passingFacts());
    f.set(EXEC_HEALTH_KEY, { value: { obs: { provider: 'worker', slot: null, receivedAt: T - 5_000, quality: [] }, green: true, detail: '40 attempts, 0 failed' }, moment: at(T - 5_000, SLOT - 12n) });
    const r = evaluateRegime(contextOf(f), deps('live'));
    expect(r.reasons).toEqual([]);
    expect(r.on).toBe(true);
  });

  it('P-EXEC-ZERO: with owner limits set, zero paper attempts is not a red execution-health verdict', () => {
    const limits = { minAttempts: 20, maxFailedBps: 1_000, maxLandingSlots: 4, maxQuoteErrorBps: 100 };
    const w = new FactWorld({ ...OPTIONS, execHealth: limits }).push(offchain(RAW.exec, { attempts: 0, failed: 0, landingSlotsP50: null, quoteErrorBpsP50: null }, 1_000n, 1_000_000));
    // Nothing was attempted because the regime was off; no attempt is no evidence of bad execution.
    expect(w.last(EH)).toMatchObject({ green: true });
  });

  it('P-SURV-DAY: one day with no recorded graduate among the 14 median days leaves survival computable', () => {
    const p = policy.regime;
    const items: { mint: string; migratedAtMs: number; reserveAfter: bigint }[] = [];
    // A graduate every hour for 16 days, except a 26 h outage starting 5 days ago (nothing recorded while down).
    for (let h = 0; h < 16 * 24; h++) {
      const migratedAtMs = T - p.survivalAfterMs - 10 * MINUTE_MS - h * HOUR_MS;
      const mark = migratedAtMs + p.survivalAfterMs;
      if (mark < T - 5 * DAY_MS && mark > T - 5 * DAY_MS - 26 * HOUR_MS) continue;
      items.push({ mint: `G${h}`, migratedAtMs, reserveAfter: h % 2 === 0 ? 40_000_000_000n : 10_000_000_000n });
    }
    const g = { obs: { provider: 'test', slot: SLOT - 3n, receivedAt: T - 1_000, quality: [], commitment: 'confirmed' as const }, items };
    const c = survivalCondition(g, T, p);
    // Control: what refuses is the one empty day, nothing else in the series.
    expect(c).toMatchObject({ ok: null, detail: expect.stringMatching(/^no graduates in day -[56] /) });
    expect(c.ok).not.toBeNull();
  });

  it('P-DIAG-GRAD: under the S0 diagnostic an old (unjudged) graduates snapshot does not turn the regime off', () => {
    const f: Facts = new Map(passingFacts());
    const g = f.get(GRADUATES_KEY)!;
    const old = T - 3 * HOUR_MS;
    f.set(GRADUATES_KEY, { value: { ...(g.value as object), obs: { provider: 'test', slot: SLOT - 27_000n, receivedAt: old, quality: [], commitment: 'confirmed' } }, moment: at(old, SLOT - 27_000n) });
    // Control: with a fresh snapshot the same facts turn it on.
    expect(evaluateRegime(contextOf(passingFacts()), { ...deps('live'), s0Diagnostic: true }).on).toBe(true);
    const r = evaluateRegime(contextOf(f), { ...deps('live'), s0Diagnostic: true });
    expect(r.reasons).toEqual([]);
    expect(r.on).toBe(true);
  });

  it('P-SOL-EDGE: at the top of the hour, before that hour\'s SOL/USD read lands, the regime stays on', () => {
    // The worker's reader accepts a bar only 2 h after its start (worker readers.ts:986), so just before the hourly read
    // lands the newest point is T - 2 h; the age limit is exactly 2 h (series.ts HOURLY_MAX_AGE_MS): zero margin.
    const f: Facts = new Map(passingFacts());
    f.set(SOL_USD_KEY, { value: { obs: { provider: 'coinbase', slot: null, receivedAt: T - HOUR_MS, quality: [] }, points: solPoints(T - 2 * HOUR_MS, 40) }, moment: at(T - HOUR_MS, SLOT - 9_000n) });
    const before: Moment = { slot: SLOT - 3n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T - 1_000 };
    const after: Moment = { slot: SLOT + 3n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T + 1_000 };
    // Control: one second before the hour it is on.
    expect(evaluateRegime(contextOf(f, before), { ...deps('backtest') }).on).toBe(true);
    const r = evaluateRegime(contextOf(f, after), { ...deps('backtest') });
    expect(r.reasons).toEqual([]);
    expect(r.on).toBe(true);
  });
});
