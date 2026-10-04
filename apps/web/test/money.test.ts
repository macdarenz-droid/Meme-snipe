import { describe, expect, it } from 'vitest';
import { addUsd, drawdownsUsd, formatPriceDec, formatR, formatSolExact, formatUsdExact, fromMicro, isUsd, MoneyError, toMicro, toneOf } from '../src/lib/money.ts';

describe('exact money', () => {
  it('adds decimal strings without float error', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addUsd('0.1', '0.2')).toBe('0.3');
    expect(addUsd('-12.000001', '12.000001')).toBe('0');
    expect(addUsd(...Array.from({ length: 1000 }, () => '0.000001'))).toBe('0.001');
  });

  it('round-trips through micro-dollars', () => {
    for (const s of ['0', '1', '-1', '0.000001', '-0.5', '123456789.123456']) expect(fromMicro(toMicro(s))).toBe(s);
    expect(fromMicro(toMicro('1.500000'))).toBe('1.5');
  });

  it('refuses anything that is not an exact dollar string', () => {
    for (const bad of ['1.0000001', '1e3', '', ' 1', '1.', '.5', 'NaN', '+1']) expect(() => toMicro(bad)).toThrow(MoneyError);
    expect(isUsd(1.5)).toBe(false);
    expect(isUsd('1.5')).toBe(true);
  });

  it('formats at the edge, rounding half away from zero', () => {
    expect(formatUsdExact('1234.565')).toBe('$1,234.57');
    expect(formatUsdExact('-1234.565')).toBe('−$1,234.57');
    expect(formatUsdExact('0.004', true)).toBe('$0.00');
    expect(formatUsdExact('0.005', true)).toBe('+$0.01');
    expect(formatUsdExact('25000', true)).toBe('+$25,000.00');
    expect(formatUsdExact('-0.004')).toBe('$0.00');
  });

  it('colours by the printed cents, never by a hidden fraction', () => {
    expect(toneOf('0.004')).toBe('');
    expect(toneOf('0.005')).toBe('gain');
    expect(toneOf('-0.01')).toBe('loss');
  });

  it('measures drawdown from the high-water mark exactly', () => {
    expect(drawdownsUsd(['0', '10.1', '4.05', '12', '11.999999'])).toEqual(['0', '0', '-6.05', '0', '-0.000001']);
  });

  it('formats prices and R multiples', () => {
    expect(formatPriceDec('0.0000412300')).toBe('$0.0000412');
    expect(formatPriceDec('0.5')).toBe('$0.5000');
    expect(formatPriceDec('0')).toBe('$0.00');
    expect(formatR('1.5')).toBe('+1.50R');
    expect(formatR('-0.8')).toBe('−0.80R');
    expect(formatR('0.001')).toBe('0.00R');
  });
});

describe('SOL amounts (PAPER-1)', () => {
  it('prints the exact SOL result, signed on request, never rounded', () => {
    expect(formatSolExact('0.004000000', true)).toBe('+0.004 SOL');
    expect(formatSolExact('-0.004000000', true)).toBe('−0.004 SOL');
    expect(formatSolExact('0.000000001')).toBe('0.000000001 SOL');
    expect(formatSolExact('1234.5')).toBe('1,234.5 SOL');
    expect(formatSolExact('0.000000000', true)).toBe('0 SOL');
    expect(() => formatSolExact('1e3')).toThrow(MoneyError);
  });
});
