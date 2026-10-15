// Ruling Z07-31: during a clock disagreement an exit prices on the worse proceeds of its two reads.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { worseProceeds } from '../../src/m04/exit-price.ts';

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
