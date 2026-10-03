// Soft features (docs/ARCHITECTURE.md §7.2): logged, never a reject; unknown is logged as unknown, never filled in.
import { describe, expect, it } from 'vitest';
import { evaluateSoftFeatures, holdersKey, softKey } from '../../src/gates/index.ts';
import { MINT, contextOf, deps, drop, obs, passingFacts, patch } from './world.ts';

const feature = (r: ReturnType<typeof evaluateSoftFeatures>, name: string) => r.features.find((f) => f.name === name);

describe('soft features', () => {
  it('passes reported values through and marks the rest unknown', () => {
    const r = evaluateSoftFeatures(contextOf(passingFacts()), deps(), MINT);
    expect(feature(r, 'solPerTrade')).toEqual({ name: 'solPerTrade', value: '400000000' });
    expect(feature(r, 'creationSlotBuyers')).toEqual({ name: 'creationSlotBuyers', value: '3' });
    expect(feature(r, 'twoSidedWalletBps')).toEqual({ name: 'twoSidedWalletBps', value: null, note: 'not reported' });
    expect(feature(r, 'independentHolders')?.value).toBe('31');
    expect(feature(r, 'indexMints')?.value).toBe('1');
    expect(feature(r, 'indexRugs')?.value).toBe('0');
  });

  it("ignores RugCheck's single-holder flag when the largest holder is a known vault (live)", () => {
    const r = evaluateSoftFeatures(contextOf(passingFacts()), deps('live'), MINT);
    expect(feature(r, 'rugcheckSingleHolderFlag')).toEqual({ name: 'rugcheckSingleHolderFlag', value: 'false', note: 'ignored: the largest holder is a known vault' });
    const bt = evaluateSoftFeatures(contextOf(passingFacts()), deps('backtest'), MINT);
    expect(feature(bt, 'rugcheckSingleHolderFlag')).toEqual({ name: 'rugcheckSingleHolderFlag', value: null, note: 'live only (§16.3)' });
  });

  it('logs unknown inputs with the reason and never throws', () => {
    const r = evaluateSoftFeatures(contextOf(drop(patch(passingFacts(), softKey(MINT), { obs: obs({ quality: ['estimated'] }) }), holdersKey(MINT))), deps(), MINT);
    expect(feature(r, 'solPerTrade')).toEqual(expect.objectContaining({ value: null, note: expect.stringContaining('estimated') }));
    expect(feature(r, 'independentHolders')).toEqual(expect.objectContaining({ value: null, note: expect.stringContaining('no holders') }));
  });
});
