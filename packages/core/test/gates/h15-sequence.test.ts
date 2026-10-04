// AUDIT-RM4 F2: H15 compares the simulated round trip (a buy, then a sell in the same transaction, on the reserves the
// buy left) with a model of that same sequence. The planned exit prices the sell on the reserves before entry, which
// costs both price impacts more; compared with it, a hidden charge up to entryImpact + exitImpact passed unseen
// (about 3 bps at $2 and several percent at $500). "Costs stay exact at any size" (CLAUDE.md).
import { describe, expect, it } from 'vitest';
import { poolBuyExactQuoteIn, poolSell } from '../../src/amm/index.ts';
import { evaluateHardRejects, simKey, type HardGate } from '../../src/gates/index.ts';
import { microUsdToLamports, type Lamports, type MicroUsd } from '../../src/units/index.ts';
import { BASE_VAULT, FEE_CONTEXT, MINT, POOL, QUOTE_VAULT, SOL_PRICE, contextOf, deps, passingFacts, patch, request, roundTrip, session } from './world.ts';

const POOL_STATE = { baseReserve: BASE_VAULT, quoteVault: QUOTE_VAULT, virtualQuoteReserves: POOL.virtualQuoteReserves ?? 0n };

/** The simulated sequence, modelled independently: the buy, then the sell of its tokens on the pool it left. */
const sequence = (spend: Lamports) => {
  const b = poolBuyExactQuoteIn(POOL_STATE, spend, FEE_CONTEXT);
  if (!b.ok) throw new Error(b.detail);
  const s = poolSell(b.trade.after, b.trade.base, FEE_CONTEXT);
  if (!s.ok) throw new Error(s.detail);
  return { paid: b.trade.userQuote, proceeds: s.trade.userQuote };
};

const h15 = (spend: Lamports, sim: { paid: bigint; proceeds: bigint }) => {
  const facts = patch(passingFacts(), simKey(MINT), { spend, ...sim });
  const r = evaluateHardRejects(contextOf(facts), deps('live', session()), request({ spend, roundTrip: roundTrip(spend) }), { stopAtFirst: false });
  return r.reasons.filter((x) => x.gate === 'H15' || x.neededBy === ('H15' as HardGate)).map((x) => x.code);
};

const usd = (dollars: bigint): Lamports => microUsdToLamports((dollars * 1_000_000n) as MicroUsd, SOL_PRICE as MicroUsd, 'ceil');

describe('H15 compares the simulation with the same sequence modelled', () => {
  for (const dollars of [2n, 500n]) {
    it(`at $${dollars}: an honest simulation passes; one short by the gap to the planned exit is a sim-loss`, () => {
      const spend = usd(dollars);
      const q = roundTrip(spend);
      if (!q.ok) throw new Error(q.detail);
      const seq = sequence(spend);
      expect(seq.paid).toBe(q.trade.paid);
      // The planned exit (reserves before entry) gets less than the immediate sell: that gap could hide a charge.
      const gap = seq.proceeds - q.trade.proceeds;
      expect(gap).toBeGreaterThan(16n);
      expect(h15(spend, seq)).toEqual([]);
      // A charge the model does not know of, equal to the gap: the simulation then reports the planned exit's proceeds.
      expect(h15(spend, { paid: seq.paid, proceeds: seq.proceeds - gap })).toEqual(['sim-loss']);
      // The rounding bound stays exactly 16 lamports.
      expect(h15(spend, { paid: seq.paid, proceeds: seq.proceeds - 16n })).toEqual([]);
      expect(h15(spend, { paid: seq.paid, proceeds: seq.proceeds - 17n })).toEqual(['sim-loss']);
    });
  }

  it('the gap grows with size: a few bps at $2, percent-scale at $500', () => {
    const bps = (dollars: bigint) => {
      const spend = usd(dollars);
      const q = roundTrip(spend);
      if (!q.ok) throw new Error(q.detail);
      return Number(((sequence(spend).proceeds - q.trade.proceeds) * 10_000n) / q.trade.paid);
    };
    expect(bps(2n)).toBeLessThan(10);
    expect(bps(500n)).toBeGreaterThan(100);
  });
});
