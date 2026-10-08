// UI-T06 table logic: exact sorting of big-integer and decimal strings (where a JS number would tie or misorder),
// malformed values sorted last instead of throwing, the one-flash-per-second throttle, streamed-insert counting,
// keyboard row moves and resizing, header groups, and the copy-as-JSON text.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { FLASH_INTERVAL_MS, NEW_ROW_MS, columnGroups, compareValues, insertedAbove, nextRowIndex, resizeByKey, rowCopyText, shouldFlash, type SortType } from '../src/lib/table.ts';

const sorted = (values: Array<string | number>, type: SortType): Array<string | number> => [...values].sort((a, b) => compareValues(a, b, type));
const params = { seed: 20261006, numRuns: 300 };

describe('UI-T06 sorting', () => {
  it('sorts BigInt strings exactly, beyond 2^53 and across the u64 and i64 ranges', () => {
    assert.deepEqual(sorted(['18446744073709551615', '9007199254740993', '-9223372036854775808', '9007199254740992', '0', '-5', '18446744073709551614'], 'bigint'),
      ['-9223372036854775808', '-5', '0', '9007199254740992', '9007199254740993', '18446744073709551614', '18446744073709551615']);
    // A JS number cannot tell these apart.
    assert.equal(Number('9007199254740993'), Number('9007199254740992'));
    assert.equal(compareValues('9007199254740993', '9007199254740992', 'bigint'), 1);
    assert.equal(compareValues('42', '42', 'bigint'), 0);
  });

  it('agrees with BigInt order for any pair of i128-range integers (property)', () => {
    const big = fc.bigInt({ min: -(2n ** 127n), max: 2n ** 127n - 1n });
    fc.assert(fc.property(big, big, (x, y) => Math.sign(compareValues(x.toString(), y.toString(), 'bigint')) === (x < y ? -1 : x > y ? 1 : 0)), params);
  });

  it('sorts decimal strings exactly at their common scale', () => {
    assert.deepEqual(sorted(['0.51', '0.000004712', '-1.5', '0.0000047120000001', '10', '0.5'], 'decimal'),
      ['-1.5', '0.000004712', '0.0000047120000001', '0.5', '0.51', '10']);
    assert.equal(compareValues('0.000004321', '0.0000043210', 'decimal'), 0);
    assert.equal(compareValues('1.000000000000000000000000000001', '1', 'decimal'), 1);
  });

  it('agrees with exact rational order for decimals (property)', () => {
    const dec = fc.tuple(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.integer({ min: 0, max: 18 })).map(([units, scale]) => {
      const neg = units < 0n;
      const digits = (neg ? -units : units).toString().padStart(scale + 1, '0');
      const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
      return { text: neg && units !== 0n ? `-${text}` : text, units, scale };
    }).filter((d) => !/^-0(\.0+)?$/.test(d.text));
    fc.assert(fc.property(dec, dec, (x, y) => {
      const s = Math.max(x.scale, y.scale);
      const [p, q] = [x.units * 10n ** BigInt(s - x.scale), y.units * 10n ** BigInt(s - y.scale)];
      return Math.sign(compareValues(x.text, y.text, 'decimal')) === (p < q ? -1 : p > q ? 1 : 0);
    }), params);
  });

  it('sorts numbers, text (case-insensitive) and ISO times', () => {
    assert.deepEqual(sorted([42, -1, 300, 0], 'number'), [-1, 0, 42, 300]);
    assert.deepEqual(sorted(['wif', 'BONK', 'bome', 'Bonk'], 'text'), ['bome', 'BONK', 'Bonk', 'wif']);
    assert.equal(compareValues('BONK', 'bonk', 'text'), 0);
    assert.deepEqual(sorted(['2026-10-06T14:02:11.123Z', '2026-10-06T13:41:05.512Z', '2026-10-06T14:02:11.124Z'], 'time'),
      ['2026-10-06T13:41:05.512Z', '2026-10-06T14:02:11.123Z', '2026-10-06T14:02:11.124Z']);
    assert.equal(compareValues('2026-10-06T14:02:11.123Z', '2026-10-06T14:02:11.123Z', 'time'), 0);
  });

  it('places malformed values after valid ones instead of throwing', () => {
    assert.deepEqual(sorted(['12', '1.5', '-3', 'abc'], 'bigint'), ['-3', '12', '1.5', 'abc']);
    assert.equal(compareValues('x', 'y', 'bigint'), 0);
    assert.deepEqual(sorted(['1e5', '0.5', '-0', '0.25'], 'decimal'), ['0.25', '0.5', '1e5', '-0']);
    assert.equal(compareValues('nope', 'nah', 'decimal'), 0);
  });
});

describe('UI-T06 value flash throttle', () => {
  it('flashes a cell at most once a second', () => {
    assert.equal(FLASH_INTERVAL_MS, 1000);
    assert.equal(shouldFlash(undefined, 0), true);
    assert.equal(shouldFlash(0, 999), false);
    assert.equal(shouldFlash(0, 1000), true);
  });

  it('a value changing 20 times a second for 3 s flashes 3 times (at 0, 1 and 2 s)', () => {
    let last: number | undefined;
    const flashes: number[] = [];
    for (let t = 0; t < 3000; t += 50) {
      if (shouldFlash(last, t)) { last = t; flashes.push(t); }
    }
    assert.deepEqual(flashes, [0, 1000, 2000]);
    assert.equal(NEW_ROW_MS, 2000);
  });
});

describe('UI-T06 streamed inserts', () => {
  it('counts new ids above the anchor; none at the top', () => {
    const prev = ['a', 'b', 'c', 'd'];
    assert.equal(insertedAbove(prev, ['x', 'y', 'z', 'a', 'b', 'c', 'd'], 'c'), 3);
    assert.equal(insertedAbove(prev, ['a', 'x', 'b', 'c', 'y', 'd'], 'c'), 1);
    assert.equal(insertedAbove(prev, ['x', 'a', 'b'], null), 0);
    assert.equal(insertedAbove(prev, ['b', 'a', 'c', 'd'], 'c'), 0);
  });

  it('a removed anchor falls back to the next surviving row, or the last survivor before it at the end (review M1)', () => {
    const prev = ['a', 'b', 'c', 'd'];
    // c removed, x above it: anchored to d, x is above.
    assert.equal(insertedAbove(prev, ['x', 'a', 'b', 'd'], 'c'), 1);
    // c removed in the same update that appends z at the bottom: z is not above the view.
    assert.equal(insertedAbove(prev, ['a', 'b', 'd', 'z'], 'c'), 0);
    // c and d removed: the next survivor after c is none, so the anchor is b; only x is above it.
    assert.equal(insertedAbove(prev, ['a', 'x', 'b', 'y', 'z'], 'c'), 1);
    // The last row d removed: anchored to c; x is above c, z below it.
    assert.equal(insertedAbove(prev, ['x', 'a', 'b', 'c', 'z'], 'd'), 1);
    // No prev row survives, or the anchor was never shown: nothing to anchor to.
    assert.equal(insertedAbove(prev, ['x', 'y'], 'c'), 0);
    assert.equal(insertedAbove(prev, ['x', 'a'], 'q'), 0);
  });
});

describe('UI-T06 keyboard', () => {
  it('moves the focused row with J/K, arrows, Home and End, without wrapping', () => {
    const cases: Array<[number, string, number, number | null]> = [
      [0, 'j', 5, 1], [0, 'J', 5, 1], [0, 'ArrowDown', 5, 1], [4, 'ArrowDown', 5, 4],
      [3, 'k', 5, 2], [3, 'K', 5, 2], [3, 'ArrowUp', 5, 2], [0, 'ArrowUp', 5, 0],
      [3, 'Home', 5, 0], [1, 'End', 5, 4], [1, 'x', 5, null], [0, 'j', 0, null],
    ];
    for (const [index, key, count, want] of cases) assert.equal(nextRowIndex(index, key, count), want, `${key} from ${index} of ${count}`);
  });

  it('resizes by 8 px per arrow, 32 px with Shift, Home and End to the bounds, clamped', () => {
    assert.equal(resizeByKey(160, 'ArrowRight', false, 64, 480), 168);
    assert.equal(resizeByKey(160, 'ArrowLeft', false, 64, 480), 152);
    assert.equal(resizeByKey(160, 'ArrowRight', true, 64, 480), 192);
    assert.equal(resizeByKey(160, 'ArrowLeft', true, 64, 480), 128);
    assert.equal(resizeByKey(160, 'Home', false, 64, 480), 64);
    assert.equal(resizeByKey(160, 'End', false, 64, 480), 480);
    assert.equal(resizeByKey(70, 'ArrowLeft', false, 64, 480), 64);
    assert.equal(resizeByKey(476, 'ArrowRight', true, 64, 480), 480);
    assert.equal(resizeByKey(160, 'Enter', false, 64, 480), null);
  });
});

describe('UI-T06 header groups and copy', () => {
  it('groups consecutive columns with the same label', () => {
    assert.deepEqual(columnGroups(['Position', 'Position', 'Entry', undefined, undefined, 'Position']),
      [{ label: 'Position', span: 2 }, { label: 'Entry', span: 1 }, { label: '', span: 2 }, { label: 'Position', span: 1 }]);
    assert.deepEqual(columnGroups([]), []);
  });

  it('copies the entity as JSON with big integers as decimal strings', () => {
    const text = rowCopyText({ size_base: '18446744073709551615', stray: 18446744073709551615n, nested: [{ v: -5n }] });
    assert.deepEqual(JSON.parse(text), { size_base: '18446744073709551615', stray: '18446744073709551615', nested: [{ v: '-5' }] });
    assert.match(text, /\n {2}"size_base": "18446744073709551615"/);
  });
});
