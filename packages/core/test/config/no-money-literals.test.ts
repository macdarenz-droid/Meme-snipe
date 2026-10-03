import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'vitest';

// CFG-1 item 5 (CLAUDE.md "Capital and trade size scale"): no dollar or SOL amount is written into code under
// packages/core/src except in config/. Limits are configuration. Scans code with comments removed.

const SRC = join(import.meta.dirname, '..', '..', 'src');
/** Folders that may hold literals: test or fixture folders at any depth if any appear under src, and config/ at the top. */
const TEST_FOLDERS = new Set(['test', 'tests', '__tests__', 'fixtures', '__fixtures__']);
/**
 * Named constants that are not trade limits. Each is a unit conversion factor or a rounding tolerance, not an amount the bot
 * may spend or lose. Adding to this list needs the supervisor's OK.
 */
const NOT_LIMITS: readonly string[] = [
  'LAMPORTS_PER_SOL', // 1 SOL = 1e9 lamports
  'MICRO_PER_USD', // 1 USD = 1e6 micro-dollars
  'ROUND_TRIP_ROUNDING_LAMPORTS', // rounding slack when comparing a quoted round trip to a cost estimate
];

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const NUM = String.raw`\d[\d_,]*(?:\.\d+)?n?`;
const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['dollar amount ($20, $0.5)', /\$\s?\d/],
  ['number followed by USD, USDC, SOL or lamports', new RegExp(String.raw`\b${NUM}\s*(?:USDC?|SOL|lamports)\b`, 'i')],
  ['money built from a literal', new RegExp(String.raw`\b(?:usd|sol|microUsd|lamports)\(\s*['"]?[1-9]${NUM.slice(String.raw`\d`.length)}`)],
  ['money constant', new RegExp(String.raw`\b[A-Za-z0-9_]*(?:USD|SOL|LAMPORTS|NOTIONAL|BANKROLL)[A-Za-z0-9_]*\s*(?::[^=;]+)?=\s*['"]?${NUM}`, 'i')],
];

/** Lines in `source` that write a money amount. */
export const findMoneyLiterals = (source: string): string[] => {
  const hits: string[] = [];
  stripComments(source).split('\n').forEach((line, i) => {
    if (NOT_LIMITS.some((n) => new RegExp(String.raw`\b${n}\s*=`).test(line))) return;
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`line ${i + 1}: ${name}: ${line.trim()}`);
  });
  return hits;
};

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return TEST_FOLDERS.has(entry) || (dir === SRC && entry === 'config') ? [] : files(full);
    return full.endsWith('.ts') ? [full] : [];
  });

describe('CFG-1 item 5: no money literals in code outside config/', () => {
  test('the scanner catches each kind of literal', () => {
    for (const bad of [
      'const fee = "$2.50";',
      'const q = 5 SOL;',
      'const MIN_TRADE_USD = 2_000_000n;',
      'export const MAX_TRADE_USD: MicroUsd = 5000000n as MicroUsd;',
      'const cap = usd("5");',
      'const floor = lamports(15_000_000n);',
      'const bankroll = microUsd(20000000);',
      'const OPS_RESERVE_LAMPORTS = 15_000_000;',
      'const SOME_OTHER_LAMPORTS = 16n;',
    ]) {
      expect(findMoneyLiterals(bad), bad).not.toEqual([]);
    }
  });

  test('the scanner ignores comments, zero and one, and plain code', () => {
    for (const ok of [
      '// the trial uses $2 to $5 and 0.015 SOL',
      '/* $20 bankroll\n 5 SOL */',
      'const zero = lamports(0n);',
      'const x = lamports(fee + 1n);',
      'const price = solPriceMicroUsd(input);',
      'const t = `${a}$${b}`;',
      'export const LAMPORTS_PER_SOL = 1_000_000_000n;',
    ]) {
      expect(findMoneyLiterals(ok), ok).toEqual([]);
    }
  });

  test('packages/core/src holds none outside config/', () => {
    const found = files(SRC).flatMap((file) => {
      const hits = findMoneyLiterals(readFileSync(file, 'utf8'));
      return hits.map((h) => `${relative(SRC, file).split(sep).join('/')} ${h}`);
    });
    expect(found).toEqual([]);
  });

  test('config/ is where the amounts live', () => {
    const inConfig = readdirSync(join(SRC, 'config')).filter((f) => f.endsWith('.ts'));
    expect(inConfig).toContain('policy.ts');
    expect(findMoneyLiterals(readFileSync(join(SRC, 'config', 'policy.ts'), 'utf8')).length).toBeGreaterThan(0);
  });
});
