// RED TEAM (code-level fail-open, not reachable on mainnet): a swap whose event timestamp `ms()` cannot turn into
// milliseconds (negative, or past 2^53 ms) is applied to the pool chain but silently left out of the candles, with no
// 'partial' flag (`#swap`: `if (book === undefined || atMs === null) return;`; the heal's replay and `#bookTake` skip it
// the same way). H11 then reads candles missing a trade as complete.
//
// Realism: PumpSwap stamps every Buy/SellEvent with `Clock::unix_timestamp`, which is positive and far below 2^53/1000,
// so a genuine mainnet event never hits this. Only a decoder bug or a corrupted record would. Severity LOW; the fix is
// one line (flag the book partial instead of returning).
import { describe, expect, it } from 'vitest';
import { candles, head, logOf, opened, tape, verdicts } from './kit.ts';

describe('red team: a swap with an unusable timestamp', () => {
  it('is never left out of the candles silently: they are flagged partial (H11 refuses)', () => {
    const { world, state } = opened();
    const s = tape(state);
    const bad = { ...s[2]!, data: { ...s[2]!.data, timestamp: -1n } };
    world.push(logOf(s[0]!), logOf(s[1]!), logOf(bad), logOf(s[3]!), logOf(s[4]!));
    head(world);
    expect({ quality: candles(world).obs.quality, H11: verdicts(world).candles }).toEqual({ quality: ['partial'], H11: expect.not.stringMatching(/^ok$/) });
  });
});
