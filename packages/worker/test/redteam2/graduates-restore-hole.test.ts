// RED TEAM 2 / regime survival: a restored graduates series is released as current although it holds nothing for
// the downtime, so the survival condition is judged on a 24 h window that is mostly unobserved.
//
// Scenario. PERSIST-2 saves the graduates series; on restart the worker releases it as `read:graduates-seed`
// (worker.ts:1006). FactProducer.#seedGraduates (core/src/facts/producer.ts:1711) adds the items and #flushGraduates
// (producer.ts:1764) dates the graduates fact at the CURRENT event's receipt time, not at the seed's `asOfMs`. The
// regime (core/src/gates/regime.ts:179) takes `g.obs.receivedAt` as how far the graduate series has "reached", and
// `survivalCondition` has no notion of coverage, so after a 20 h outage the current check's "last 24 h" survival
// share is computed from the 4 h before the outage only, and judged (ok true/false), never unknown. A graduate whose
// survival mark fell during the downtime is simply absent (also any graduate whose read failed or whose pool stream had
// a hole: `#survival` settles it without an item, producer.ts:1757), so missing evidence reads as a smaller sample.
// The backtest never has such a hole, so live and backtest can differ.
// Realism: MEDIUM. Needs a restart after hours of downtime (host outage, a failed deploy); a short restart leaves
// a small hole. Expected (fail-closed): the restored series is dated at its own as-of (or carries its covered
// range), so a 24 h window with an unobserved stretch is unknown and the regime is off until it is observed.
import { describe, expect, it } from 'vitest';
import { RAW } from '../../../core/src/facts/index.ts';
import { GRADUATES_KEY, parseGraduates, survivalCondition } from '../../../core/src/gates/index.ts';
import { TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { FactWorld, offchain, slotNotice } from '../../../core/test/facts/helpers.ts';

const HOUR = 3_600_000;
const A = 1_791_039_600_000; // the saved state's as-of (an hour boundary)
const DOWN = 20 * HOUR; // the outage

describe('RT2-REG-a: a restored graduates series and the downtime hole', () => {
  it('the restored series is not dated past its own as-of, and survival over the unobserved window is not judged', () => {
    const p = TRIAL_POLICY.regime;
    // 16 days of graduates before the save, one every 2 h, all well above the floor.
    const items = Array.from({ length: 16 * 12 }, (_, k) => ({ mint: `G${k}`, migratedAtMs: A - p.survivalAfterMs - k * 2 * HOUR, reserveAfter: p.survivalReserveFloor + 1_000_000_000n }));
    const w = new FactWorld().push(
      offchain(RAW.graduatesSeed, { source: 'persist', asOfMs: A, items }, 1_000n, A + DOWN),
      slotNotice(1_001n, A + DOWN + 1_000),
    );
    const g = parseGraduates(w.last(GRADUATES_KEY));
    expect(g).not.toBeNull();
    const check = Math.floor((A + DOWN) / HOUR) * HOUR;
    // On 959d801 survival is judged (ok: true) for the 24 h before `check`, of which 20 h were never observed.
    const s = survivalCondition(g!, check, p);
    // Correct: either the fact is dated no later than the series' as-of (then the regime's check is too old: off)...
    const datedHonestly = g!.obs.receivedAt <= A;
    // ...or survival over a window the series did not observe is unknown.
    expect(datedHonestly || s.ok === null, `graduates fact dated ${g!.obs.receivedAt - A} ms after the series' as-of; survival at the check ${JSON.stringify(s)}`).toBe(true);
  });
});
