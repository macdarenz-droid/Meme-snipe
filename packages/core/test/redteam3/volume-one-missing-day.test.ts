// RED TEAM A round 3, "never trades" class (merged base 9f7cf812): one missing or tampered chain-volume day turns the
// regime off for up to 365 days.
//
// `volumeCondition` (core/src/gates/regime.ts) needs EVERY UTC day from max(2026-07-20, L-364) to L = D-3 to be present
// (`volumeWindowDays` 365); one absent day is `not-covered`, so the regime is off on every check, live and backtest. A
// day is absent when the data job never publishes it, when any of its 24 hours is uncovered (`covered: 0`), or when its
// release ever changes after the worker verified it: readers.ts marks it `tampered`, saves the mark, and "the day is
// never used again, after a restart too" (DECISIONS FACTS-1d). So a single bad or re-published day blocks every coin
// until it leaves the window: up to 365 days. The 25th percentile it feeds would still rest on hundreds of days without
// it; failing closed here is bookkeeping, not a real lack of evidence (the minimum, `volumeMinDays` 28, is already met).
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { VOLUME_SERIES_START_DAY } from '../../src/config/time.ts';
import { volumeCondition } from '../../src/gates/regime.ts';
import type { CurveVolumeFact } from '../../src/gates/facts.ts';

const p = startSession(TRIAL_POLICY).policy.regime;
const DAY = 86_400_000;
const D = VOLUME_SERIES_START_DAY + 200; // a check about 200 days into the series
const at = D * DAY + 3_600_000;
const fact = (skip: number | null): CurveVolumeFact => ({
  obs: { provider: 'github', slot: null, receivedAt: at, quality: [] },
  days: Array.from({ length: D - VOLUME_SERIES_START_DAY }, (_, i) => VOLUME_SERIES_START_DAY + i)
    .filter((d) => d !== skip).map((day) => ({ day, volumeLamports: 1_000_000_000_000n + BigInt(day % 7) * 1_000_000_000n })),
});

describe('NT-1: one missing chain-volume day 150 days back', () => {
  it('control: the full series is judged', () => {
    expect(volumeCondition(fact(null), at, p).ok).not.toBeNull();
  });

  it('with 196 of 197 days present the volume condition is still judged, not unknown (fails on 9f7cf812: regime off until the day leaves the 365-day window)', () => {
    const r = volumeCondition(fact(VOLUME_SERIES_START_DAY + 50), at, p);
    expect({ ok: r.ok, detail: 'detail' in r ? r.detail : '' }).toMatchObject({ ok: expect.any(Boolean) });
  });
});
