// UI-T03 money and unit formatting: table-driven cases (at least 200) for every quantity of the DS formatting table,
// the acceptance criteria, the edge cases, and property tests against string arithmetic (acceptance 7).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { SAMPLE_ADDRESS, SAMPLE_MINT } from '../src/fixtures.ts';
import { monotonicClock } from '../src/lib/clock.ts';
import {
  ContractError, MINUS, UNKNOWN, formatAge, formatBps, formatDuration, formatFeeLamports, formatLamports, formatMicroLamportsPerCu,
  formatPrice, formatSlot, formatSol, formatTime, formatTokenAmount, formatUsdE6, groupThousands, parseAt, parseDecimalStr, type TokenOptions,
  parseI128Str, parseI64Str, parseU64Str, sanitizeUntrusted, scriptOf, spoken, truncateMiddle, type Formatted,
} from '../src/lib/money.ts';

const M = MINUS;
let cases = 0;
/** Runs a table of [input, expected text] cases through `f` and counts them. */
function table<I>(name: string, rows: ReadonlyArray<readonly [I, string]>, f: (input: I) => Formatted | string): void {
  it(name, () => {
    for (const [input, expected] of rows) {
      const out = f(input);
      assert.equal(typeof out === 'string' ? out : out.text, expected, `${name}: ${JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
    }
  });
  cases += rows.length;
}

describe('UI-T03 acceptance criteria', () => {
  it('1: one lamport at 4 dp is <0.0001 SOL; tooltip 0.000000001 SOL (1 lamport)', () => {
    const f = formatSol('1', { dp: 4 });
    assert.equal(f.text, '<0.0001 SOL');
    assert.equal(f.tooltip, '0.000000001 SOL (1 lamport)');
  });
  it('2: -4500000 lamports signed is −0.0045 SOL with U+2212', () => {
    const f = formatSol('-4500000', { signed: true });
    assert.equal(f.text, '−0.0045 SOL');
    assert.equal(f.label, 'minus 0.0045 SOL');
  });
  it('3: base 123456789 with 6 decimals is 123.4568, exact 123.456789', () => {
    const f = formatTokenAmount('123456789', 6);
    assert.equal(f.text, '123.4568');
    assert.equal(f.exact, '123.456789');
    assert.equal(f.tooltip, '123.456789 (123,456,789 base units, 6 decimals)');
  });
  it('4: price 0.000004321 shows 0.0₅4321 with the accessible label 0.000004321', () => {
    const f = formatPrice('0.000004321');
    assert.equal(f.text, '0.0₅4321');
    assert.equal(f.label, '0.000004321');
  });
  it('5: 3500 bps as pct is 35.00%; 35 bps as bps is 35 bps', () => {
    assert.equal(formatBps(3500, { as: 'pct' }).text, '35.00%');
    assert.equal(formatBps(35, { as: 'bps' }).text, '35 bps');
  });
  it('6: a symbol with U+202E loses the control character; mixed scripts are reported', () => {
    const s = sanitizeUntrusted('US\u202EDC', 12);
    assert.equal(s.text, 'USDC');
    assert.equal(s.removedControls, true);
    assert.equal(s.mixedScript, false);
    const mixed = sanitizeUntrusted('U\u202ESDС', 12);   // the last letter is Cyrillic ES
    assert.equal(mixed.text, 'USDС');
    assert.equal(mixed.mixedScript, true);
    assert.equal(mixed.nonLatin, true);
  });
});

describe('UI-T03 edge cases', () => {
  it('u64 max lamports, i64 min, decimals 0 and 18, a tiny price', () => {
    assert.equal(formatSol('18446744073709551615').exact, '18,446,744,073.709551615 SOL');
    assert.equal(formatSol('-9223372036854775808', { signed: true }).exact, `${M}9,223,372,036.854775808 SOL`);
    assert.equal(formatTokenAmount('18446744073709551615', 0).text, '18,446,744,073,709,551,615.0000');
    assert.equal(formatTokenAmount('18446744073709551615', 18).exact, '18.446744073709551615');
    assert.equal(formatPrice('0.000000000123').text, '0.0₉123');
  });
  it('an empty string or "01" throws a typed ContractError', () => {
    for (const bad of ['', '01']) {
      assert.throws(() => formatSol(bad), (e: unknown) => e instanceof ContractError && e.code === 'E_U64' && e.name === 'ContractError');
    }
  });
  it('null returns the unknown marker —', () => {
    for (const f of [formatSol(null), formatLamports(null), formatFeeLamports(null), formatMicroLamportsPerCu(null), formatTokenAmount(null, 6),
      formatTokenAmount('1', null), formatPrice(null), formatUsdE6(null), formatBps(null, { as: 'bps' }), formatDuration(null),
      formatAge(null, 0, 0), formatTime(null), formatSlot(null)]) assert.equal(f, UNKNOWN);
    assert.equal(UNKNOWN.text, '—');
  });
});

describe('UI-T03 parsers', () => {
  const bad = (f: (s: string) => unknown, code: string, inputs: string[]): void => {
    for (const s of inputs) assert.throws(() => f(s), (e: unknown) => e instanceof ContractError && e.code === code, s);
    cases += inputs.length;
  };
  it('U64Str', () => {
    assert.equal(parseU64Str('0'), 0n);
    assert.equal(parseU64Str('18446744073709551615'), 18446744073709551615n);
    bad(parseU64Str, 'E_U64', ['', '01', '-1', '+1', '1e3', '1.0', ' 1', '18446744073709551616', '99999999999999999999', '123456789012345678901', 'x'.repeat(60)]);
  });
  it('I64Str', () => {
    assert.equal(parseI64Str('-9223372036854775808'), -9223372036854775808n);
    assert.equal(parseI64Str('9223372036854775807'), 9223372036854775807n);
    bad(parseI64Str, 'E_I64', ['', '-0', '-01', '9223372036854775808', '-9223372036854775809', '--1', '1.5']);
  });
  it('I128Str', () => {
    assert.equal(parseI128Str('-170141183460469231731687303715884105728'), -170141183460469231731687303715884105728n);
    bad(parseI128Str, 'E_I128', ['', '-0', '00', '1'.repeat(40)]);
  });
  it('DecimalStr', () => {
    assert.deepEqual(parseDecimalStr('0.000004321'), { units: 4321n, scale: 9 });
    assert.deepEqual(parseDecimalStr('-12.5'), { units: -125n, scale: 1 });
    assert.deepEqual(parseDecimalStr('7'), { units: 7n, scale: 0 });
    bad(parseDecimalStr, 'E_DECIMAL', ['', '.5', '1.', '01', '1e-9', '-0', '-0.000', `0.${'1'.repeat(31)}`, '1,000']);
  });
  it('the error message quotes at most 48 characters of the input', () => {
    assert.throws(() => parseU64Str('9'.repeat(100)), (e: unknown) => e instanceof Error && e.message.length < 80 && e.message.includes('…'));
  });
});

describe('UI-T03 SOL amounts', () => {
  table<readonly [string, Parameters<typeof formatSol>[1]]>('formatSol text', [
    [['0', {}], '0.0000 SOL'],
    [['1', {}], '<0.0001 SOL'],
    [['49999', {}], '<0.0001 SOL'],
    [['50000', {}], '0.0001 SOL'],
    [['99999', {}], '0.0001 SOL'],
    [['149999', {}], '0.0001 SOL'],
    [['150000', {}], '0.0002 SOL'],
    [['1000000000', {}], '1.0000 SOL'],
    [['1234567890123', {}], '1,234.5679 SOL'],
    [['999999950000', {}], '1,000.0000 SOL'],
    [['5000', { dp: 6 }], '0.000005 SOL'],
    [['499', { dp: 6 }], '<0.000001 SOL'],
    [['500', { dp: 6 }], '0.000001 SOL'],
    [['1', { dp: 9 }], '0.000000001 SOL'],
    [['1500000000', { dp: 0 }], '2 SOL'],
    [['1', { dp: 0 }], '<1 SOL'],
    [['12345678', { dp: 2 }], '0.01 SOL'],
    [['18446744073709551615', {}], '18,446,744,073.7096 SOL'],
    [['18446744073709551615', { compact: true }], '18.4B SOL'],
    [['999999999999999', { compact: true }], '1,000,000.0000 SOL'],
    [['999499999999999', { compact: true }], '999,500.0000 SOL'],
    [['1000000000000000', { compact: true }], '1.00M SOL'],
    [['12400000000000000', { compact: true }], '12.4M SOL'],
    [['123456000000000000', { compact: true }], '123M SOL'],
    [['999600000000000000', { compact: true }], '1.00B SOL'],
    [['0', { signed: true }], '±0 SOL'],
    [['12300000', { signed: true }], '+0.0123 SOL'],
    [['-4500000', { signed: true }], `${M}0.0045 SOL`],
    [['1', { signed: true }], '+<0.0001 SOL'],
    [['-1', { signed: true }], `${M}<0.0001 SOL`],
    [['-9223372036854775808', { signed: true }], `${M}9,223,372,036.8548 SOL`],
    [['9223372036854775807', { signed: true }], '+9,223,372,036.8548 SOL'],
    [['-1234567890000000', { signed: true, compact: true }], `${M}1.23M SOL`],
    [['-50000', { signed: true }], `${M}0.0001 SOL`],
    [['-49999', { signed: true }], `${M}<0.0001 SOL`],
  ], ([v, o]) => formatSol(v, o));

  it('exact, tooltip and label', () => {
    const big = formatSol('1234567890123');
    assert.equal(big.exact, '1,234.567890123 SOL');
    assert.equal(big.tooltip, '1,234.567890123 SOL (1,234,567,890,123 lamports)');
    assert.equal(big.label, '1,234.5679 SOL');
    assert.equal(formatSol('0', { signed: true }).label, '0 SOL');
    assert.equal(formatSol('12300000', { signed: true }).label, 'plus 0.0123 SOL');
    assert.equal(formatSol('-1', { signed: true }).label, 'minus less than 0.0001 SOL');
    assert.equal(formatSol('12400000000000000', { compact: true }).label, '12,400,000.0000 SOL', 'compact values are read out in full');
    assert.equal(formatSol('-1', { signed: true }).tooltip, `${M}0.000000001 SOL (${M}1 lamport)`);
    assert.throws(() => formatSol('-1'), /not a U64Str/, 'a balance is never negative');
  });

  table('formatLamports', [['0', '0 lamports'], ['1', '1 lamport'], ['5000', '5,000 lamports'], ['18446744073709551615', '18,446,744,073,709,551,615 lamports']] as const,
    (v) => formatLamports(v));
  table('formatFeeLamports: lamports under 0.001 SOL, SOL above', [
    ['5000', '5,000 lamports'], ['999999', '999,999 lamports'], ['1000000', '0.001000 SOL'], ['2500001', '0.002500 SOL'], ['1', '1 lamport'],
  ] as const, (v) => formatFeeLamports(v));
  it('fee tooltips show both units', () => {
    assert.equal(formatLamports('5000').tooltip, '5,000 lamports (0.000005000 SOL)');
    assert.equal(formatFeeLamports('2500001').tooltip, '0.002500001 SOL (2,500,001 lamports)');
  });
  table('formatMicroLamportsPerCu', [['0', '0 micro-lamports/CU'], ['1000000', '1,000,000 micro-lamports/CU'], ['25', '25 micro-lamports/CU']] as const,
    (v) => formatMicroLamportsPerCu(v));
  it('compute-unit price tooltip and label', () => {
    assert.equal(formatMicroLamportsPerCu('1500').tooltip, '1,500 micro-lamports/CU (0.001500 lamports per CU)');
    assert.equal(formatMicroLamportsPerCu('1500').label, '1,500 micro-lamports per compute unit');
  });
});

describe('UI-T03 token amounts', () => {
  const tok = (b: string, d: number, o: TokenOptions, t: string): readonly [readonly [string, number, TokenOptions], string] => [[b, d, o], t];
  table<readonly [string, number, TokenOptions]>('formatTokenAmount text', [
    tok('0', 6, {}, '0.0000'), tok('1', 6, {}, '<0.0001'), tok('50', 6, {}, '0.0001'), tok('123456789', 6, {}, '123.4568'),
    tok('123456789', 0, {}, '123,456,789.0000'), tok('123456789', 9, {}, '0.1235'), tok('1', 18, {}, '<0.0001'), tok('100000000000000', 18, {}, '0.0001'),
    tok('1000000000000000000', 18, {}, '1.0000'), tok('123456789', 6, { dp: 6 }, '123.456789'), tok('123456789', 6, { dp: 9 }, '123.456789'),
    tok('123456789', 6, { dp: 2 }, '123.46'), tok('12400000000000', 6, { compact: true }, '12.4M'), tok('999999000000', 6, { compact: true }, '999,999.0000'),
    tok('1000000000000', 6, { compact: true }, '1.00M'), tok('18446744073709551615', 0, { compact: true }, '18.4Qi'),
    tok('18446744073709551615', 9, { compact: true }, '18.4B'), tok('0', 0, {}, '0.0000'), tok('5', 1, {}, '0.5000'),
    tok('-123456789', 6, { signed: true }, `${M}123.4568`), tok('0', 6, { signed: true }, '±0'), tok('10', 6, { signed: true }, '+<0.0001'),
    tok('-170141183460469231731687303715884105728', 0, { signed: true, compact: true }, `${M}170,141,183,460,469,231,731,687,303,715,884,105,728.0000`),
    tok('999500000000000000000', 0, { compact: true, signed: true }, '+999,500,000,000,000,000,000.0000'),
    tok('999400000000000000000', 0, { compact: true, signed: true }, '+999Qi'), tok('999600000000000000', 0, { compact: true }, '1.00Qi'),
  ], ([b, d, o]) => formatTokenAmount(b, d, o));
  it('decimals must be an integer 0-255', () => {
    for (const d of [-1, 256, 1.5, Number.NaN]) assert.throws(() => formatTokenAmount('1', d), (e: unknown) => e instanceof ContractError && e.code === 'E_DECIMALS');
    assert.equal(formatTokenAmount('1', 255).exact, `0.${'0'.repeat(254)}1`);
    cases += 5;
  });
  it('labels read compact amounts in full', () => {
    assert.equal(formatTokenAmount('12400000000000', 6, { compact: true }).label, '12,400,000.0000');
  });
});

describe('UI-T03 prices', () => {
  table('formatPrice text (4 significant digits; zero-compressed below 0.001)', [
    ['0', '0'], ['1', '1'], ['1.5', '1.5'], ['1.23456', '1.235'], ['12.3456', '12.35'], ['123.456', '123.5'], ['1234.56', '1,235'],
    ['12345.678', '12,346'], ['0.5', '0.5'], ['0.012345', '0.01235'], ['0.0012345', '0.001235'], ['0.001', '0.001'],
    ['0.00099996', '0.001'], ['0.000999', '0.0₃999'], ['0.0009999', '0.0₃9999'], ['0.000004321', '0.0₅4321'],
    ['0.0000043216', '0.0₅4322'], ['0.0000099996', '0.0₄1'], ['0.000000000123', '0.0₉123'], ['0.0000000000001', '0.0₁₂1'],
    ['-0.000004321', `${M}0.0₅4321`], ['-1.5', `${M}1.5`], ['9.99996', '10'], ['99999.5', '100,000'],
    [`0.${'0'.repeat(29)}1`, '0.0₂₉1'],
  ] as const, (v) => formatPrice(v));
  it('sig digits, label and tooltip are the full decimal', () => {
    assert.equal(formatPrice('1.23456', { sig: 2 }).text, '1.2');
    assert.equal(formatPrice('0.000004321', { sig: 2 }).text, '0.0₅43');
    assert.equal(formatPrice('-0.000004321').label, 'minus 0.000004321');
    assert.equal(formatPrice('-0.000004321').tooltip, `${M}0.000004321`);
    assert.throws(() => formatPrice('1e-9'), ContractError);
  });
});

describe('UI-T03 USD', () => {
  table<readonly [string, Parameters<typeof formatUsdE6>[1]]>('formatUsdE6 text', [
    [['0', {}], '$0.00'], [['1', {}], '<$0.01'], [['4999', {}], '<$0.01'], [['5000', {}], '$0.01'], [['1234560000', {}], '$1,234.56'],
    [['1234565000', {}], '$1,234.57'], [['1234564999', {}], '$1,234.56'], [['-1234560000', {}], `${M}$1,234.56`],
    [['1234560000', { approx: true }], '≈$1,234.56'], [['12300000', { signed: true }], '+$12.30'], [['0', { signed: true }], '±$0.00'],
    [['-1', { signed: true }], `${M}<$0.01`], [['-1234567891', { signed: true, approx: true }], `≈${M}$1,234.57`],
    [['9223372036854775807', {}], '$9,223,372,036,854.78'], [['-9223372036854775808', {}], `${M}$9,223,372,036,854.78`],
  ], ([v, o]) => formatUsdE6(v, o));
  it('exact and label', () => {
    assert.equal(formatUsdE6('-1234567891', { signed: true, approx: true }).exact, `${M}$1,234.567891`);
    assert.equal(formatUsdE6('-1234567891', { signed: true, approx: true }).label, 'approximately minus $1,234.57');
    assert.equal(formatUsdE6('1').label, 'less than $0.01');
  });
});

describe('UI-T03 basis points', () => {
  table<readonly [number, Parameters<typeof formatBps>[1]]>('formatBps text', [
    [[35, { as: 'bps' }], '35 bps'], [[0, { as: 'bps' }], '0 bps'], [[1250, { as: 'bps' }], '1,250 bps'], [[-35, { as: 'bps' }], `${M}35 bps`],
    [[3500, { as: 'pct' }], '35.00%'], [[5234, { as: 'pct' }], '52.34%'], [[1, { as: 'pct' }], '0.01%'], [[0, { as: 'pct' }], '0.00%'],
    [[10000, { as: 'pct' }], '100.00%'], [[-1250, { as: 'pct' }], `${M}12.50%`], [[25000, { as: 'pct' }], '250.00%'],
    [[1250, { as: 'pct', signed: true }], '+12.50%'], [[0, { as: 'pct', signed: true }], '±0.00%'], [[-5, { as: 'bps', signed: true }], `${M}5 bps`],
    [[2147483647, { as: 'pct' }], '21,474,836.47%'],
  ], ([v, o]) => formatBps(v, o));
  it('tooltips show the other unit; non-integers are a contract error', () => {
    assert.equal(formatBps(35, { as: 'bps' }).tooltip, '0.35%');
    assert.equal(formatBps(3500, { as: 'pct' }).tooltip, '3,500 bps');
    assert.equal(formatBps(-1250, { as: 'pct' }).label, 'minus 12.50%');
    for (const v of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) assert.throws(() => formatBps(v, { as: 'bps' }), (e: unknown) => e instanceof ContractError && e.code === 'E_BPS');
    cases += 4;
  });
});

describe('UI-T03 time', () => {
  table('formatDuration', [
    [0, '<1 ms'], [0.4, '<1 ms'], [0.99, '<1 ms'], [1, '1 ms'], [85, '85 ms'], [85.4, '85 ms'], [999.4, '999 ms'], [999.6, '1.0 s'],
    [1200, '1.2 s'], [1249, '1.2 s'], [1250, '1.3 s'], [59940, '59.9 s'], [59960, '1m 00s'], [252000, '4m 12s'], [7380000, '2h 03m'],
    [273600000, '3d 4h'],
  ] as const, (v) => formatDuration(v));
  it('a negative, infinite or NaN duration is a contract error', () => {
    for (const v of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => formatDuration(v), (e: unknown) => e instanceof ContractError && e.code === 'E_MS');
    assert.equal(formatDuration(85.4).tooltip, '85.4 ms');
    cases += 3;
  });

  const from = '2026-10-06T14:02:11.123Z';
  const at = (iso: string): number => Date.parse(iso);
  table<readonly [number, number]>('formatAge (now + offset − as_of)', [
    [[at('2026-10-06T14:02:11.123Z'), 0], '0s'], [[at('2026-10-06T14:02:23.122Z'), 0], '11s'], [[at('2026-10-06T14:02:23.123Z'), 0], '12s'],
    [[at('2026-10-06T14:06:23.123Z'), 0], '4m 12s'], [[at('2026-10-06T14:07:16.123Z'), 0], '5m 05s'], [[at('2026-10-06T16:05:11.123Z'), 0], '2h 03m'],
    [[at('2026-10-09T18:02:11.123Z'), 0], '3d 4h'], [[at('2026-10-06T14:02:00.000Z'), 0], '0s'], [[at('2026-10-06T14:02:11.123Z'), 6000], '6s'],
    [[at('2026-10-06T14:02:21.123Z'), -4000], '6s'], [[at('2026-10-06T14:02:11.123Z'), -60000], '0s'],
  ], ([now, offset]) => formatAge(from, now, offset));
  it('age tooltip is the full ISO time; malformed timestamps are refused', () => {
    assert.equal(formatAge(from, at(from), 0).tooltip, from);
    for (const bad of ['2026-10-06T14:02:11Z', '2026-10-06 14:02:11.123Z', '2026-10-06T14:02:11.123+00:00', '', '2026-13-45T99:99:99.999Z']) {
      assert.throws(() => parseAt(bad), (e: unknown) => e instanceof ContractError && e.code === 'E_AT', bad);
    }
    cases += 5;
  });
  it('dates that do not exist are refused, not rolled forward (review m4)', () => {
    for (const bad of ['2026-02-30T00:00:00.000Z', '2026-02-31T23:59:59.999Z', '2026-06-31T00:00:00.000Z', '2026-10-07T24:00:00.000Z', '2025-02-29T12:00:00.000Z', '2026-12-31T23:59:60.000Z']) {
      assert.throws(() => parseAt(bad), (e: unknown) => e instanceof ContractError && e.code === 'E_AT', bad);
    }
    for (const good of ['2028-02-29T12:00:00.000Z', '2026-06-30T23:59:59.999Z', '2026-10-07T00:00:00.000Z', '0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
      assert.equal(new Date(parseAt(good)).toISOString(), good);
    }
  });
  table('formatTime (UTC)', [['2026-10-06T14:02:11.123Z', '14:02:11'], ['2026-10-06T00:00:00.000Z', '00:00:00'], ['2026-12-31T23:59:59.999Z', '23:59:59']] as const,
    (v) => formatTime(v));
  it('formatTime local uses the local clock fields', () => {
    const d = new Date(Date.parse('2026-10-06T14:02:11.123Z'));
    const pad = (n: number): string => String(n).padStart(2, '0');
    assert.equal(formatTime('2026-10-06T14:02:11.123Z', 'local').text, `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
    assert.equal(formatTime('2026-10-06T14:02:11.123Z').tooltip, '2026-10-06T14:02:11.123Z');
  });
  table('formatSlot: plain digits, no separators', [['0', '0'], ['312345678', '312345678'], ['18446744073709551615', '18446744073709551615']] as const,
    (v) => formatSlot(v));
});

describe('UI-T03 identifiers and untrusted text', () => {
  table<readonly [string, number, number]>('truncateMiddle', [
    [[SAMPLE_ADDRESS, 4, 4], '9xQe…VFin'], [['short', 4, 4], 'short'], [['123456789', 4, 4], '123456789'],
    [['1234567890', 4, 4], '1234…7890'], [['abcdefghij', 2, 3], 'ab…hij'],
  ], ([v, h, t]) => truncateMiddle(v, h, t));
  it('truncateMiddle defaults to 4 + 4', () => assert.equal(truncateMiddle(SAMPLE_MINT), 'So11…1112'));

  table<readonly [string, number]>('sanitizeUntrusted text', [
    [['BONK', 12], 'BONK'], [['  BO  NK\t\n', 12], 'BO NK'], [['\u202EKNOB', 12], 'KNOB'], [['A\u2066B\u2069C', 12], 'ABC'],
    [['Z\u200BE\u200CR\u200DO\uFEFF', 12], 'ZERO'], [['RLM\u200FLRM\u200E', 12], 'RLMLRM'], [['ab\u0000cd\u0007', 12], 'ab cd'],
    [['ABCDEFGHIJKLMNOP', 12], 'ABCDEFGHIJK…'], [['ABCDEFGHIJKL', 12], 'ABCDEFGHIJKL'], [['😀😀😀😀', 3], '😀😀…'],
    [['x'.repeat(200), 32], `${'x'.repeat(31)}…`], [['\u202A\u202B\u202C\u202D', 12], ''],
  ], ([v, n]) => sanitizeUntrusted(v, n).text);
  it('strips every format and default-ignorable character, so a hidden one cannot make a look-alike (review m2)', () => {
    for (const hidden of ['\u2060', '\u2064', '\u00AD', '\u180E', '\u{E0041}', '\u{E0001}', '\u{E007F}', '\uFE0F', '\u034F', '\u3164', '\u115F', '\u{1D173}', '\u061C', '\u{E0100}']) {
      const s = sanitizeUntrusted(`U${hidden}SDC`, 12);
      assert.deepEqual([s.text, s.removedControls], ['USDC', true], `U+${(hidden.codePointAt(0) as number).toString(16).toUpperCase()}`);
    }
    // Every code point of both classes is removed (exhaustive over the code space).
    const invisible = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
    for (let cp = 0; cp <= 0x10FFFF; cp += 1) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      const c = String.fromCodePoint(cp);
      if (invisible.test(c)) assert.equal(sanitizeUntrusted(`A${c}B`, 12).text, 'AB', `U+${cp.toString(16)}`);
    }
    // Visible text is untouched.
    assert.deepEqual([sanitizeUntrusted('USDC', 12).text, sanitizeUntrusted('USDC', 12).removedControls], ['USDC', false]);
  });

  it('flags: removed controls, truncation, scripts', () => {
    const s = sanitizeUntrusted('ABCDEFGHIJKLMNOP', 12);
    assert.deepEqual([s.truncated, s.full, s.removedControls, s.mixedScript, s.nonLatin], [true, 'ABCDEFGHIJKLMNOP', false, false, false]);
    assert.deepEqual([sanitizeUntrusted('ПЕПЕ', 12).mixedScript, sanitizeUntrusted('ПЕПЕ', 12).nonLatin], [false, true]);
    assert.equal(sanitizeUntrusted('猫 Cat', 12).mixedScript, true);
    assert.equal(sanitizeUntrusted('1234 $!', 12).nonLatin, false);
    assert.equal(sanitizeUntrusted('Ⅻ', 12).nonLatin, false, 'not a letter');
    assert.deepEqual(['a', 'Я', 'α', 'ա', 'א', 'ب', '中', 'ひ', 'カ', '한', 'ก', 'क', 'Ꭰ', 'ა', 'ᚠ'].map(scriptOf),
      ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Hebrew', 'Arabic', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Devanagari', 'Cherokee', 'Georgian', 'Other']);
  });
  it('groupThousands agrees with digit-by-digit grouping and runs in linear time (review m3)', () => {
    const reference = (d: string): string => [...d].map((c, i) => (i > 0 && (d.length - i) % 3 === 0 ? `,${c}` : c)).join('');
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom(...'0123456789'), maxLength: 40 }), (d) => groupThousands(d) === reference(d)), { seed: 20261007, numRuns: 500 });
    assert.equal(groupThousands(''), '');
    // The regex grouping took 6.1 s for 80,000 digits (quadratic); linear grouping takes milliseconds.
    const big = `1${'0'.repeat(80_000)}`;
    const t0 = monotonicClock.nowMs();
    const text = formatPrice(big).text;
    const grouped = groupThousands(`1${'0'.repeat(1_000_000)}`);
    const took = monotonicClock.nowMs() - t0;
    assert.ok(took < 1500, `took ${took} ms`);
    assert.equal(text.split(',').length, Math.ceil(80_001 / 3), 'every digit of the 80,001-digit integer part, grouped');
    assert.equal(grouped.length, 1_000_001 + 333_333);
  });

  it('groupThousands and spoken', () => {
    assert.deepEqual(['0', '999', '1000', '1234567'].map(groupThousands), ['0', '999', '1,000', '1,234,567']);
    assert.equal(spoken(`≈${M}<$0.01`), 'approximately minus less than $0.01');
    assert.equal(spoken('±0 SOL'), '0 SOL');
    assert.equal(spoken('12 SOL'), '12 SOL');
  });
});

/** Reference: inserts the decimal point into a digit string with string operations only (no BigInt, no number). */
function refExact(digits: string, scale: number): string {
  const padded = digits.padStart(scale + 1, '0');
  const int = padded.slice(0, padded.length - scale).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return scale === 0 ? int : `${int}.${padded.slice(padded.length - scale)}`;
}

/** Reference: rounds a digit string at `scale` to `dp` decimals, half up, with string carry. */
function refRound(digits: string, scale: number, dp: number): string {
  const padded = digits.padStart(scale + 1, '0');
  const cut = padded.length - (scale - dp);
  let kept = padded.slice(0, cut).split('');
  if ((padded[cut] ?? '0') >= '5') {
    let i = kept.length - 1;
    while (i >= 0 && kept[i] === '9') { kept[i] = '0'; i -= 1; }
    if (i < 0) kept = ['1', ...kept];
    else kept[i] = String.fromCharCode((kept[i] as string).charCodeAt(0) + 1);
  }
  return refExact(kept.join('').replace(/^0+(?=\d)/, ''), dp);
}

describe('UI-T03 acceptance 7: no precision lost above Number.MAX_SAFE_INTEGER (property tests, string arithmetic)', () => {
  const params = { seed: 20261006, numRuns: 500 };
  const u64 = fc.bigInt({ min: 0n, max: 18446744073709551615n });
  const aboveSafe = fc.bigInt({ min: BigInt(Number.MAX_SAFE_INTEGER) + 1n, max: 18446744073709551615n });

  it('SOL: the exact text equals the string-arithmetic decimal, and the rounded text equals string rounding', () => {
    fc.assert(fc.property(fc.oneof(u64, aboveSafe), (v) => {
      const s = v.toString();
      const f = formatSol(s);
      assert.equal(f.exact, `${refExact(s, 9)} SOL`);
      const rounded = refRound(s, 9, 4);
      assert.equal(f.text, rounded === '0.0000' && v !== 0n ? '<0.0001 SOL' : `${rounded} SOL`);
      assert.equal(parseU64Str(f.exact.replace(/[,. A-Z]/g, '').replace(/^0+(?=\d)/, '')), v, 'round trip');
    }), params);
  });

  it('signed SOL (i64)', () => {
    fc.assert(fc.property(fc.bigInt({ min: -9223372036854775808n, max: 9223372036854775807n }), (v) => {
      const mag = (v < 0n ? -v : v).toString();
      const sign = v < 0n ? M : v > 0n ? '+' : '';
      assert.equal(formatSol(v.toString(), { signed: true }).exact, `${sign}${refExact(mag, 9)} SOL`);
    }), params);
  });

  it('token amounts with any decimals 0-30', () => {
    fc.assert(fc.property(fc.oneof(u64, aboveSafe), fc.integer({ min: 0, max: 30 }), (v, d) => {
      const s = v.toString();
      const f = formatTokenAmount(s, d);
      assert.equal(f.exact, refExact(s, d));
      const rounded = d >= 4 ? refRound(s, d, 4) : refExact(`${s}${'0'.repeat(4 - d)}`, 4);
      assert.equal(f.text, rounded === '0.0000' && v !== 0n ? '<0.0001' : rounded);
    }), params);
  });

  it('USD micro-dollars and lamport counts', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 9223372036854775807n }), (v) => {
      const s = v.toString();
      assert.equal(formatUsdE6(s).exact, `$${refExact(s, 6)}`);
      assert.equal(formatLamports(s).text, `${refExact(s, 0)} ${v === 1n ? 'lamport' : 'lamports'}`);
      assert.equal(formatSlot(s).text, s);
    }), params);
  });

  it('prices keep the full decimal in the label, and the compressed digits are the rounded significant digits', () => {
    fc.assert(fc.property(fc.integer({ min: 4, max: 30 }), fc.bigInt({ min: 1n, max: 99999999n }), (scale, units) => {
      const digits = units.toString();
      fc.pre(digits.length <= scale);
      const decimal = refExact(digits, scale).replace(/,/g, '');
      const f = formatPrice(decimal);
      assert.equal(f.label, decimal);
      if (f.text.startsWith('0.0') && /[₀-₉]/.test(f.text)) {
        const zeros = Number([...f.text.slice(3).match(/^[₀-₉]+/)?.[0] ?? ''].map((c) => '₀₁₂₃₄₅₆₇₈₉'.indexOf(c)).join(''));
        const rest = f.text.slice(3).replace(/^[₀-₉]+/, '');
        assert.ok(zeros >= 3 && rest.length >= 1 && rest.length <= 4 && !rest.endsWith('0'), f.text);
      }
    }), params);
  });
});

describe('UI-T03 case count', () => {
  it('runs at least 200 table-driven cases', () => {
    assert.ok(cases >= 200, `only ${cases} cases`);
  });
});
