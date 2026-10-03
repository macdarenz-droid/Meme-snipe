import { describe, expect, test } from 'vitest';
import {
  base58ByteLength, checkFreshness, entryKey, exitKey, intentId, isMint, isSignature, mint, positionId, signature, walletAddress,
  type Observation,
} from '../src/domain/index.ts';
import { base58Encode, key32, sig } from './fixtures.ts';

describe('base58 identifiers', () => {
  test('known program addresses are 32 bytes', () => {
    expect(base58ByteLength('11111111111111111111111111111111')).toBe(32);
    expect(base58ByteLength('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(32);
    expect(mint('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  });
  test('rejects non-base58 characters, wrong lengths and empty input', () => {
    for (const bad of ['', '0OIl', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5D0', 'abc', key32(3) + '1']) {
      expect(() => walletAddress(bad)).toThrow(RangeError);
    }
    expect(isMint('So1111111111111111111111111111111111111111')).toBe(false);
    expect(base58ByteLength('So1111111111111111111111111111111111111111')).not.toBe(32);
    expect(isMint('So11111111111111111111111111111111111111112')).toBe(true);
  });
  test('signatures are 64 bytes; a 32-byte key is not a signature', () => {
    expect(isSignature(sig(1))).toBe(true);
    expect(isSignature(key32(1))).toBe(false);
    expect(() => signature(key32(1))).toThrow(RangeError);
    expect(base58ByteLength(base58Encode(new Uint8Array(64)))).toBe(64);
  });
  test('idempotency keys are deterministic per decision and per exit owner', () => {
    const m = mint(key32(2));
    expect(entryKey(m, 'd1')).toBe(entryKey(m, 'd1'));
    expect(entryKey(m, 'd1')).not.toBe(entryKey(m, 'd2'));
    expect(exitKey(positionId('p1'), 1)).toBe('exit:p1:1');
    expect(() => exitKey(positionId('p1'), 0)).toThrow(RangeError);
    expect(() => intentId('has space')).toThrow(RangeError);
  });
});

describe('freshness', () => {
  const obs = (eventTime: number, receivedAt: number): Observation<number> => ({
    kind: 'quote',
    value: 1,
    provenance: { provider: 'p', mint: mint(key32(2)), pool: null, slot: 1n, eventTime, receivedAt, commitment: 'confirmed', quality: [] },
  });
  const budgets = { quote: 2_000 };

  test('fresh inside the budget, stale past it (the boundary is fresh)', () => {
    expect(checkFreshness(obs(10_000, 10_100), 12_000, budgets)).toEqual({ fresh: true, ageMs: 2_000 });
    expect(checkFreshness(obs(10_000, 10_100), 12_001, budgets)).toEqual({ fresh: false, reason: 'stale', ageMs: 2_001 });
  });
  test('missing evidence or a kind without a budget is a failure, never a pass', () => {
    expect(checkFreshness(undefined, 1, budgets).fresh).toBe(false);
    expect(checkFreshness(null, 1, budgets)).toMatchObject({ reason: 'missing' });
    expect(checkFreshness(obs(10_000, 10_000), 10_000, {})).toMatchObject({ fresh: false, reason: 'no-budget' });
    expect(checkFreshness(obs(10_000, 10_000), 10_000, { quote: Number.NaN })).toMatchObject({ reason: 'no-budget' });
  });
  test('invalid or future times fail', () => {
    expect(checkFreshness(obs(Number.NaN, 10_000), 10_000, budgets)).toMatchObject({ reason: 'invalid-time' });
    expect(checkFreshness(obs(10_000.5, 10_000), 10_000, budgets)).toMatchObject({ reason: 'invalid-time' });
    expect(checkFreshness(obs(20_000, 20_000), 10_000, budgets)).toMatchObject({ reason: 'from-future' });
    expect(checkFreshness(obs(15_000, 10_000), 15_000, budgets)).toMatchObject({ reason: 'from-future' });
    expect(checkFreshness(obs(10_500, 10_000), 10_500, budgets).fresh).toBe(true); // inside 1 s skew
  });
});
