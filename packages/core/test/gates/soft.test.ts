// Soft features (docs/ARCHITECTURE.md §7.2): logged, never a reject; unknown is logged as unknown, never filled in.
import { describe, expect, it } from 'vitest';
import { SOFT_BIGINTS, SOFT_FLAGS, SOFT_NUMBERS, evaluateSoftFeatures, holdersKey, softKey } from '../../src/gates/index.ts';
import { MINT, contextOf, deps, drop, obs, passingFacts, patch, session } from './world.ts';

const feature = (r: ReturnType<typeof evaluateSoftFeatures>, name: string) => r.features.find((f) => f.name === name);

describe('soft features', () => {
  it('passes reported values through and marks the rest unknown', () => {
    const r = evaluateSoftFeatures(contextOf(passingFacts()), deps('live', session(), 'RUG-1'), MINT);
    expect(feature(r, 'solPerTrade')).toEqual({ name: 'solPerTrade', value: '400000000' });
    expect(feature(r, 'creationSlotBuyers')).toEqual({ name: 'creationSlotBuyers', value: '3' });
    expect(feature(r, 'twoSidedWalletBps')).toEqual({ name: 'twoSidedWalletBps', value: null, note: 'not reported' });
    expect(feature(r, 'observedDistinctOwners')?.value).toBe('59');
    for (const name of ['knownLinkedOwners', 'supportedIndependentOwners', 'unresolvedOwners']) expect(feature(r, name)).toEqual({ name, value: null, note: 'not reported' });
    expect(feature(r, 'indexMints')?.value).toBe('1');
    expect(feature(r, 'indexRugs')?.value).toBe('0');
  });

  it("ignores RugCheck's single-holder flag when the largest holder is a known vault (live)", () => {
    const r = evaluateSoftFeatures(contextOf(passingFacts()), deps('live'), MINT);
    expect(feature(r, 'rugcheckSingleHolderFlag')).toEqual({ name: 'rugcheckSingleHolderFlag', value: 'false', note: 'ignored: the largest holder is a known vault' });
    const bt = evaluateSoftFeatures(contextOf(patch(passingFacts(), softKey(MINT), { rugcheckScore: 4633 })), deps('backtest'), MINT);
    expect(feature(bt, 'rugcheckSingleHolderFlag')).toEqual({ name: 'rugcheckSingleHolderFlag', value: null, note: 'live only (§16.3)' });
    expect(feature(bt, 'rugcheckScore')).toEqual({ name: 'rugcheckScore', value: null, note: 'live only (§16.3)' });
    expect(bt.features.filter((f) => f.name === 'rugcheckScore')).toHaveLength(1);
  });

  it('logs unknown inputs with the reason and never throws', () => {
    const r = evaluateSoftFeatures(contextOf(drop(patch(passingFacts(), softKey(MINT), { obs: obs({ quality: ['estimated'] }) }), holdersKey(MINT))), deps(), MINT);
    expect(feature(r, 'solPerTrade')).toEqual(expect.objectContaining({ value: null, note: expect.stringContaining('estimated') }));
    expect(feature(r, 'observedDistinctOwners')).toEqual(expect.objectContaining({ value: null, note: expect.stringContaining('no holders') }));
  });

  it('takes the linked, independent and unresolved owner counts from the producer, never from the holder list', () => {
    const r = evaluateSoftFeatures(contextOf(patch(passingFacts(), softKey(MINT), { knownLinkedOwners: 4, supportedIndependentOwners: 20, unresolvedOwners: 35 })), deps(), MINT);
    expect(feature(r, 'knownLinkedOwners')).toEqual({ name: 'knownLinkedOwners', value: '4' });
    expect(feature(r, 'supportedIndependentOwners')).toEqual({ name: 'supportedIndependentOwners', value: '20' });
    expect(feature(r, 'unresolvedOwners')).toEqual({ name: 'unresolvedOwners', value: '35' });
    expect(feature(r, 'independentHolders')).toBeUndefined();
    // "independent" appears only on values the producer reports with funding evidence, never on one computed here.
    const reported = new Set<string>([...SOFT_NUMBERS, ...SOFT_BIGINTS, ...SOFT_FLAGS]);
    expect(r.features.filter((f) => /independent/i.test(f.name) && !reported.has(f.name))).toEqual([]);
  });
});
