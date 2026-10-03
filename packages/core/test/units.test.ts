import { describe, expect, test } from 'vitest';
import {
  applyBps, bps, lamports, lamportsToMicroUsd, microUsd, microUsdToLamports, mulDiv, raw, solPriceMicroUsd, toDecimalString,
} from '../src/units/index.ts';

describe('constructors', () => {
  test('reject negatives and non-integers', () => {
    expect(() => lamports(-1)).toThrow(RangeError);
    expect(() => lamports(1.5)).toThrow(RangeError);
    expect(() => raw(-1n)).toThrow(RangeError);
    expect(() => bps(10_001)).toThrow(RangeError);
    expect(() => bps(12.5)).toThrow(RangeError);
    expect(() => lamports(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
  test('accept valid values', () => {
    expect(lamports(5000)).toBe(5000n);
    expect(bps(125)).toBe(125);
    expect(microUsd(-3)).toBe(-3n);
  });
});

describe('mulDiv', () => {
  test('rounds floor and ceil for positive and negative results', () => {
    expect(mulDiv(7n, 1n, 2n, 'floor')).toBe(3n);
    expect(mulDiv(7n, 1n, 2n, 'ceil')).toBe(4n);
    expect(mulDiv(-7n, 1n, 2n, 'floor')).toBe(-4n);
    expect(mulDiv(-7n, 1n, 2n, 'ceil')).toBe(-3n);
    expect(mulDiv(6n, 1n, 2n, 'ceil')).toBe(3n);
  });
  test('rejects a non-positive divisor', () => {
    expect(() => mulDiv(1n, 1n, 0n, 'floor')).toThrow(RangeError);
  });
});

describe('applyBps', () => {
  test('1.25% of 1 SOL, paid rounds up, received rounds down', () => {
    expect(applyBps(1_000_000_001n, bps(125), 'ceil')).toBe(12_500_001n);
    expect(applyBps(1_000_000_001n, bps(125), 'floor')).toBe(12_500_000n);
  });
});

describe('dollar conversion', () => {
  const price = solPriceMicroUsd('119.36');
  test('parses decimal prices exactly', () => {
    expect(price).toBe(119_360_000n);
    expect(() => solPriceMicroUsd('1e3')).toThrow(RangeError);
    expect(() => solPriceMicroUsd('0')).toThrow(RangeError);
    expect(() => solPriceMicroUsd('1.1234567')).toThrow(RangeError);
  });
  test('5,000 lamports at $119.36 is $0.0005968', () => {
    expect(lamportsToMicroUsd(lamports(5000), price, 'floor')).toBe(596n);
    expect(lamportsToMicroUsd(lamports(5000), price, 'ceil')).toBe(597n);
  });
  test('$2 buys about 0.01675 SOL; rounding direction is explicit', () => {
    expect(microUsdToLamports(microUsd(2_000_000), price, 'floor')).toBe(16_756_032n);
    expect(microUsdToLamports(microUsd(2_000_000), price, 'ceil')).toBe(16_756_033n);
    expect(() => microUsdToLamports(microUsd(-1), price, 'floor')).toThrow(RangeError);
  });
});

test('toDecimalString', () => {
  expect(toDecimalString(1_488_440n, 9)).toBe('0.00148844');
  expect(toDecimalString(-2_500_000n, 6)).toBe('-2.5');
  expect(toDecimalString(42n, 0)).toBe('42');
});
