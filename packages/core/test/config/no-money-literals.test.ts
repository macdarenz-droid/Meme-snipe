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
  { file: 'domain/index.ts', name: 'futureToleranceMs', value: '1000', why: 'clock skew allowance in milliseconds, not money' },
  { file: 'engine/random.ts', name: 'M1', value: '597399067', why: 'cyrb128 hash multiplier, not money' },
  { file: 'engine/random.ts', name: 'M2', value: '2869860233', why: 'cyrb128 hash multiplier, not money' },
  { file: 'engine/random.ts', name: 'M3', value: '951274213', why: 'cyrb128 hash multiplier, not money' },
  { file: 'engine/random.ts', name: 'M4', value: '2716044179', why: 'cyrb128 hash multiplier, not money' },
  { file: 'engine/random.ts', name: 'TWO_POW_32', value: '4294967296', why: 'sfc32 output scale (2^32), not money' },
  { file: 'engine/random.ts', name: 'h1', value: '1779033703', why: 'cyrb128 initial hash state, not money' },
  { file: 'engine/random.ts', name: 'h2', value: '3144134277', why: 'cyrb128 initial hash state, not money' },
  { file: 'engine/random.ts', name: 'h3', value: '1013904242', why: 'cyrb128 initial hash state, not money' },
  { file: 'engine/random.ts', name: 'h4', value: '2773480762', why: 'cyrb128 initial hash state, not money' },
  { file: 'engine/proofs.ts', name: 'REACH_BUDGET', value: '200000', why: 'node budget of the leak-test reachability search, not money' },
  { file: 'ledger/sqlite.ts', name: 'BUSY_TIMEOUT_MS', value: '5000', why: 'SQLite busy timeout in milliseconds, not money' },
  { file: 'chain/address.ts', name: 'ED25519_FIELD_PRIME', value: '57896044618658097711785492504343953926634992332820282019728792003956564819949', why: 'ed25519 field prime 2^255 - 19 (RFC 8032), for the PDA curve check' },
  { file: 'chain/address.ts', name: 'ED25519_D', value: '37095705934669439343138083508754565189542113879843219016388785533085940283555', why: 'ed25519 curve constant d (RFC 8032), for the PDA curve check' },
  // STATS-1: statistical and generator constants, not money (pending the supervisor's OK on PR #8).
  { file: 'stats/bootstrap.ts', name: 'DEFAULT_REPLICATES', value: '2000', why: 'bootstrap replicate count' },
  { file: 'stats/g2rule.ts', name: 'DEFAULT_MAX_TRADES', value: '50000', why: 'upper end of the n_power search (a trade count)' },
  { file: 'stats/g2rule.ts', name: 'SEED_STRIDE', value: '1000003', why: 'prime stride between random streams' },
  { file: 'stats/gates.ts', name: 'MS_PER_DAY', value: '86400000', why: 'milliseconds in a day' },
  { file: 'stats/rng.ts', name: 'GOLDEN_GAMMA', value: '2654435769', why: 'splitmix32 increment' },
  { file: 'stats/rng.ts', name: 'MIX_1', value: '2246822507', why: 'murmur3 finalizer multiplier' },
  { file: 'stats/rng.ts', name: 'MIX_2', value: '3266489909', why: 'murmur3 finalizer multiplier' },
  { file: 'stats/rng.ts', name: 'TWO_POW_26', value: '67108864', why: '2^26, for a 53-bit double' },
  { file: 'stats/rng.ts', name: 'TWO_POW_32', value: '4294967296', why: '2^32' },
  { file: 'stats/rng.ts', name: 'TWO_POW_53', value: '9007199254740992', why: '2^53, for a 53-bit double' },
  { file: 'stats/special.ts', name: 'MAXIT', value: '1000', why: 'iteration limit of the continued fractions' },
  { file: 'stats/special.ts', name: 'LANCZOS_C2', value: '1259.1392167224028', why: 'Lanczos log-gamma coefficient' },
  { file: 'risk/melbourne.ts', name: 'MS_PER_MINUTE', value: '60000', why: 'time unit for the Melbourne day boundary, not money' },
  { file: 'risk/melbourne.ts', name: 'EPOCH_YEAR', value: '1970', why: 'calendar year of the Unix epoch, not money' },
  { file: 'risk/melbourne.ts', name: 'RULE_FROM_YEAR', value: '2008', why: 'first year of the Victorian daylight-saving rule, not money' },
];

export const isAllowed = (file: string, finding: Finding, allowed: readonly Allowed[] = ALLOWED): boolean =>
  finding.declares !== undefined && allowed.some((a) => a.file === file && a.name === finding.declares?.name && a.value === finding.declares.value);

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return TEST_FOLDERS.has(entry) || (dir === SRC && entry === 'config') ? [] : files(full);
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(full) ? [full] : [];
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
  ['a small literal times a unit constant ($2)', 'const MIN = 2n * MICRO_PER_USD;'],
  ['a fraction of a SOL', 'const q = 5n * LAMPORTS_PER_SOL / 100n;'],
  ['a literal inside a money constructor call', 'const q = lamports(fee + 5n);'],
  ['a quote inside a regex hides the next statement (single)', "const re = /'/; const MAX_TRADE = 5_000_000n; const r2 = /'/;"],
  ['a quote inside a regex hides the next statement (double)', 'const re = /"/; const MAX_TRADE = 5_000_000n; const r2 = /"/;'],
  ['a regex after return and a class', "const f = () => { return /[']/.test(s); }; const Q = 5_000_000n;"],
  ['\\x escape in a number string', "const q = BigInt('\\x35000000');"],
  ['\\u escape in a number string', "const q = Number('\\u0035000000');"],
  ['octal escape in a number string', "const q = BigInt('\\65000000');"],
  ['\\u{} escape in a number string', "const q = parseInt('\\u{35}000000');"],
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
      'const x = lamports(fee + extra);',
      'const half = total / 2n / count;',
      'const re = /[0-9]{5000}/; const ok = re.test(s) && a / b / c;',
      "const re = /'/; const n = items.length;",
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
    expect(tokenize("x = /'/; y = a / b / c;").map((t) => t.kind)).toEqual(['id', 'punct', 'regex', 'punct', 'id', 'punct', 'id', 'punct', 'id', 'punct', 'id', 'punct']);
    expect(tokenize(String.raw`'\x35' "\u{35}"`).map((t) => t.text)).toEqual(['5', '5']);
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
