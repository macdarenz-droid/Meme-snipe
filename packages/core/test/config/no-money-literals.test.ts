import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import { type Finding, findMoneyLiterals, literalValue, tokenize } from './scan-money.ts';

// CFG-1 item 5 (CLAUDE.md "Capital and trade size scale"): no dollar or SOL amount is written into code under
// packages/core/src except in config/. Limits are configuration. The scan reads tokens, not lines or names: any number of
// 1,000 or more in any form, numeric strings handed to BigInt/Number/parseInt/parseFloat, and money constructors built
// from a literal. Limits: it cannot see an amount assembled from small numbers (for example 5 * 100 * 100).

const SRC = join(import.meta.dirname, '..', '..', 'src');
/** Test or fixture folders at any depth, and config/ at the top, may hold literals. */
const TEST_FOLDERS = new Set(['test', 'tests', '__tests__', 'fixtures', '__fixtures__']);

interface Allowed { readonly file: string; readonly name: string; readonly value: string; readonly why: string }
/**
 * Declarations that are not trade limits: unit scale factors and on-chain protocol parameters that the quote path reads as
 * inputs. Matched on exact file, declared name and value, never on a line. Adding to this list needs the supervisor's OK.
 */
const ALLOWED: readonly Allowed[] = [
  { file: 'units/index.ts', name: 'LAMPORTS_PER_SOL', value: '1000000000', why: '1 SOL = 1e9 lamports' },
  { file: 'units/index.ts', name: 'MICRO_PER_USD', value: '1000000', why: '1 USD = 1e6 micro-dollars' },
  { file: 'units/index.ts', name: 'BPS_DENOMINATOR', value: '10000', why: '100% = 10,000 basis points' },
  { file: 'costs/index.ts', name: 'PPM', value: '1000000', why: 'parts per million scale' },
  { file: 'costs/index.ts', name: 'BASE_FEE_PER_SIGNATURE', value: '5000', why: 'Solana base fee per signature (protocol fact, passed in as an input)' },
  { file: 'amm/pump-curve.ts', name: 'PARTS_PER_MILLION', value: '1000000', why: 'scale of curveProgressPpm' },
  { file: 'amm/pump-curve.ts', name: 'initialVirtualTokenReserves', value: '1073000000000000', why: 'pump Global launch parameter' },
  { file: 'amm/pump-curve.ts', name: 'initialVirtualQuoteReserves', value: '30000000000', why: 'pump Global launch parameter' },
  { file: 'amm/pump-curve.ts', name: 'initialRealTokenReserves', value: '793100000000000', why: 'pump Global launch parameter' },
  { file: 'amm/pump-curve.ts', name: 'tokenTotalSupply', value: '1000000000000000', why: 'pump Global launch parameter' },
  { file: 'amm/pump-curve.ts', name: 'poolMigrationFee', value: '15000001', why: 'pump migrate fee, a protocol parameter read as an input' },
  { file: 'domain/index.ts', name: 'futureToleranceMs', value: '1000', why: 'clock skew allowance in milliseconds, not money' },
];

export const isAllowed = (file: string, finding: Finding, allowed: readonly Allowed[] = ALLOWED): boolean =>
  finding.declares !== undefined && allowed.some((a) => a.file === file && a.name === finding.declares?.name && a.value === finding.declares.value);

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return TEST_FOLDERS.has(entry) || (dir === SRC && entry === 'config') ? [] : files(full);
    return full.endsWith('.ts') ? [full] : [];
  });
const rel = (file: string): string => relative(SRC, file).split(sep).join('/');

const BYPASSES: readonly (readonly [string, string])[] = [
  ['the original shape without a suffix', 'const MAX_TRADE = 5_000_000n;'],
  ['hex bigint', 'const q = 0x4C4B40n;'],
  ['exponent', 'const q = 5e6;'],
  ['BigInt of a string', 'const q = BigInt("5000000");'],
  ['lamports(BigInt(literal))', 'const f = lamports(BigInt(15_000_000));'],
  ['usd of a template string', 'const q = usd(`5`);'],
  ['sol of a string', "const q = sol('0.015');"],
  ['another statement on an allow-listed line', 'export const LAMPORTS_PER_SOL = 1_000_000_000n; const MAX = 5_000_000n;'],
  ['Number of a string', "const q = Number('5000000');"],
  ['parseFloat of a string', "const q = parseFloat('1e7');"],
  ['parseInt of a string', "const q = parseInt('5000000', 10);"],
  ['binary literal', 'const q = 0b10011000100101101000000;'],
  ['digit separators and a leading dot', 'const q = .5e4;'],
  ['split across lines', 'const\n  QUANTITY\n  =\n  5_000_000n\n;'],
  ['trailing comment', 'const q = 5_000_000n; // fine'],
  ['inside a template substitution', 'const s = `${5_000_000n}`;'],
  ['a power', 'const q = 10 ** 6;'],
  ['microUsd of a small literal', 'const q = microUsd(5);'],
  ['a dollar amount in text', 'const s = "$2.50";'],
  ['an amount with a unit in text', "const s = '0.015 SOL';"],
  ['a rename of an allow-listed name in another file', 'const LAMPORTS_PER_SOL = 5_000_000n;'],
];

describe('CFG-1 item 5: no money literals in code outside config/', () => {
  test.each(BYPASSES)('the scan catches: %s', (_name, code) => {
    const found = findMoneyLiterals(code);
    expect(found.length, code).toBeGreaterThan(0);
  });

  test('the scan ignores comments, small numbers, zero and ordinary code', () => {
    for (const ok of [
      '// the trial uses $2 to $5 and 5_000_000 lamports',
      '/* $20 bankroll\n 5 SOL 5_000_000n */',
      'const zero = lamports(0n);',
      'const x = lamports(fee + 1n);',
      'const price = solPriceMicroUsd(input);',
      'const t = `${a}$${b}`;',
      'const n = items.length + 999;',
      "const s = 'hello world';",
      'const re = value * 12;',
    ]) {
      expect(findMoneyLiterals(ok), ok).toEqual([]);
    }
  });

  test('the tokenizer reads values in every notation', () => {
    expect(literalValue('5_000_000n')).toBe(5_000_000n);
    expect(literalValue('0x4C4B40n')).toBe(5_000_000n);
    expect(literalValue('5e6')).toBe(5_000_000);
    expect(literalValue('0b101')).toBe(5);
    expect(literalValue('.5e4')).toBe(5000);
    expect(tokenize('a /* x */ b // y\n`t${c}`').map((t) => t.text)).toEqual(['a', 'b', 't', 'c']);
  });

  test('the allow-list is by file, name and value, never by line', () => {
    const decl = (code: string): Finding => findMoneyLiterals(code)[0] as Finding;
    expect(isAllowed('units/index.ts', decl('export const LAMPORTS_PER_SOL = 1_000_000_000n;'))).toBe(true);
    // Same declaration in another file, another value, or another name: not allowed.
    expect(isAllowed('costs/index.ts', decl('export const LAMPORTS_PER_SOL = 1_000_000_000n;'))).toBe(false);
    expect(isAllowed('units/index.ts', decl('export const LAMPORTS_PER_SOL = 2_000_000_000n;'))).toBe(false);
    expect(isAllowed('units/index.ts', decl('export const SOMETHING = 1_000_000_000n;'))).toBe(false);
    // A second statement next to an allowed one is still found.
    const two = findMoneyLiterals('export const LAMPORTS_PER_SOL = 1_000_000_000n; const MAX = 5_000_000n;');
    expect(two.map((f) => isAllowed('units/index.ts', f))).toEqual([true, false]);
    // A literal inside an expression is never a declaration.
    expect(isAllowed('units/index.ts', decl('const y = LAMPORTS_PER_SOL * 1_000_000_000n;'))).toBe(false);
  });

  test('packages/core/src holds none outside config/ except the allow-listed protocol constants', () => {
    const found = files(SRC).flatMap((file) =>
      findMoneyLiterals(readFileSync(file, 'utf8'))
        .filter((f) => !isAllowed(rel(file), f))
        .map((f) => `${rel(file)}:${f.line} ${f.why}`));
    expect(found).toEqual([]);
  });

  test('every allow-list entry still matches something (the list cannot go stale)', () => {
    const used = new Set(files(SRC).flatMap((file) =>
      findMoneyLiterals(readFileSync(file, 'utf8')).flatMap((f) => (f.declares ? [`${rel(file)}|${f.declares.name}|${f.declares.value}`] : []))));
    for (const a of ALLOWED) expect(used.has(`${a.file}|${a.name}|${a.value}`), `${a.file} ${a.name}`).toBe(true);
  });

  test('config/ is where the amounts live', () => {
    expect(findMoneyLiterals(readFileSync(join(SRC, 'config', 'policy.ts'), 'utf8')).length).toBeGreaterThan(0);
  });
});
