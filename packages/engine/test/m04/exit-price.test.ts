// Ruling Z07-31: during a clock disagreement an exit prices on the worse proceeds of its two reads.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { decideClockExit, HARD_SLIPPAGE_CEILING_BPS, worseProceeds } from '../../src/m04/exit-price.ts';

describe('ruling Z07-31: worseProceeds', () => {
  const lo = { snapshot: 'honest', proceedsLamports: 2_000n };
  const hi = { snapshot: 'liar', proceedsLamports: 999_999n };
  it('picks the smaller proceeds whichever side it is on; a tie keeps the first', () => {
    assert.equal(worseProceeds(lo, hi), lo);
    assert.equal(worseProceeds(hi, lo), lo);
    const tie = { snapshot: 'other', proceedsLamports: 2_000n };
    assert.equal(worseProceeds(lo, tie), lo);
  });
  it('an absent read is skipped; both absent is null', () => {
    assert.equal(worseProceeds(null, hi), hi);
    assert.equal(worseProceeds(lo, null), lo);
    assert.equal(worseProceeds<string>(null, null), null);
  });
});

describe('ruling Z07-33: decideClockExit', () => {
  const honest = { snapshot: 'honest', proceedsLamports: 2_000_000n };
  const liar = { snapshot: 'liar', proceedsLamports: 999_999_000n };
  const lowLiar = { snapshot: 'liar', proceedsLamports: 1_000n };
  const logged = () => { const lines: Array<[string, string, Record<string, unknown>]> = []; return { lines, log: { event: (l: 'warn', c: 'm04.exit_clock_prices', f: Readonly<Record<string, unknown>>) => { lines.push([l, c, { ...f }]); } } }; };

  it('decides on the worse proceeds and keeps the worse read\'s minOut when it is above the floor; logs both proceeds', () => {
    const { lines, log } = logged();
    const d = decideClockExit('pool', liar, honest, 1_990_000n, 1_500, log);
    assert.equal(d.priced, honest);
    assert.equal(d.minOutLamports, 1_990_000n);                      // above 2,000,000 × 85% = 1,700,000
    assert.deepEqual(lines, [['warn', 'm04.exit_clock_prices', { pool: 'pool', past_ceiling_proceeds: 999_999_000n, under_ceiling_proceeds: 2_000_000n, decided_on: 'under_ceiling', min_out: 1_990_000n, emergency_slippage_bps: 1_500 }]]);
  });

  it('MINOR-R12: a liar\'s low quote cannot drag minOut under the partner\'s proceeds less the emergency slippage', () => {
    const { lines, log } = logged();
    const d = decideClockExit('pool', lowLiar, honest, 990n, 1_500, log);
    assert.equal(d.priced, lowLiar);
    assert.equal(d.minOutLamports, 1_700_000n);
    assert.equal(lines[0]?.[2].decided_on, 'past_ceiling');
  });

  it('the emergency slippage is passed as configured: 0 and the hard ceiling are accepted, anything else throws', () => {
    const { log } = logged();
    assert.equal(decideClockExit('pool', lowLiar, honest, 0n, 0, log).minOutLamports, 2_000_000n);
    assert.equal(decideClockExit('pool', lowLiar, honest, 0n, HARD_SLIPPAGE_CEILING_BPS, log).minOutLamports, 1_500_000n);
    for (const bad of [-1, 2_501, 1.5, Number.NaN]) assert.throws(() => decideClockExit('pool', lowLiar, honest, 0n, bad, log), { code: 'E_INVALID_SLIPPAGE' });
  });
});
