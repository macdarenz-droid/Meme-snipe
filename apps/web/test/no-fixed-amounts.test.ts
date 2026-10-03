import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractText } from './copy-scan.ts';

/**
 * Bankroll, trade size and limits come from view models, never from UI text
 * (supervisor, WEB-1: the trial amounts will scale). Allowed: the exchange fee
 * table, which quotes research figures, and the dev-only fixtures.
 */
const ALLOWED = ['src/funding/exchanges.ts', 'src/dev/'];
const DOLLAR_AMOUNT = /\$\s?\d/;

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]));

async function amountsIn(code: string, file: string): Promise<string[]> {
  return (await extractText(code, file)).filter((t) => DOLLAR_AMOUNT.test(t));
}

describe('no fixed dollar amounts in UI text', () => {
  it('finds none outside the allowed files', async () => {
    const hits: string[] = [];
    for (const file of filesUnder(join(appRoot, 'src')).filter((f) => /\.tsx?$/.test(f))) {
      const rel = relative(appRoot, file);
      if (ALLOWED.some((a) => rel.startsWith(a))) continue;
      for (const t of await amountsIn(readFileSync(file, 'utf8'), file)) hits.push(`${rel}: "${t}"`);
    }
    expect(hits).toEqual([]);
  });

  it('fails on a seeded hard-coded bankroll', async () => {
    const seeded = `const rows = [['Bankroll', '$20']]; export const A = () => <dd>Entry $2, max $5</dd>;`;
    expect(await amountsIn(seeded, 'seeded.tsx')).toEqual(['$20', 'Entry $2, max $5']);
  });
});
