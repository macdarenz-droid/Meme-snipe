// OOM-MINT (supervisor ruling on the BT review, B1): a coin that migrates more than CREATE_KEEP_MS after its create is
// refused `create-expired` from the facts, in the backtest as live; one coin on both sides of twelve hours.
import { describe, expect, it } from 'vitest';
import { KEEP_SLOTS, backtestCoin, expiredIn, judgedIn } from './create-keep-world.ts';

describe('create-expired in the backtest (OOM-MINT)', () => {
  it('a migration exactly twelve hours after its create is judged; a slot more is refused at every check, before the regime', () => {
    const at = backtestCoin(KEEP_SLOTS);
    expect(expiredIn(at.decisions)).toEqual([]);
    expect(judgedIn(at.decisions).length).toBeGreaterThan(0);
    const past = backtestCoin(KEEP_SLOTS + 3);
    const judged = judgedIn(past.decisions);
    expect(judged.length).toBeGreaterThan(0);
    expect(expiredIn(past.decisions)).toEqual(judged);
    const f = Object.values(past.funnel)[0]!;
    expect(Object.keys(f.checksAt)).toEqual(['create expired']);
  });
});
