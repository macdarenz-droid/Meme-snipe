// Every string in ledger/** (adapters/ included) is checked for SQL that reads the clock, draws randomness
// or opens another database file. Same patterns as ENG-1's purity guard; this one also covers ledger/adapters,
// which that guard skips, and runs on this branch without it.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LEDGER = resolve(dirname(new URL(import.meta.url).pathname), '../../src/ledger');

const NONDETERMINISTIC_SQL: readonly RegExp[] = [
  /\bnow\b/i,
  /\bcurrent_(timestamp|date|time)\b/i,
  /\b(datetime|date|time|julianday|unixepoch)\s*\(\s*\)/i,
  /\bstrftime\s*\(\s*(['"])[^'"]*\1\s*\)/i,
  /\brandom(blob)?\s*\(/i,
  /\b(attach|detach)\b/i,
];

interface Piece { readonly text: string; readonly start: number; readonly end: number }

/** String and template literal contents, comments skipped; `${...}` parts are left out of the text. */
export const literals = (source: string): Piece[] => {
  const out: Piece[] = [];
  let i = 0;
  let lastCode = '';
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { const e = source.indexOf('*/', i + 2); i = e === -1 ? source.length : e + 2; continue; }
    if (c === '/' && /[(,=:[!&|?{};]/.test(lastCode)) { // a regular expression literal
      i++;
      let inClass = false;
      while (i < source.length && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i++;
      }
      i++;
      lastCode = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      let text = '';
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
        if (c === '`' && source[i] === '$' && source[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            i++;
          }
          text += ' ';
          continue;
        }
        text += source[i];
        i++;
      }
      i++;
      out.push({ text, start, end: i });
      lastCode = c;
      continue;
    }
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  return out;
};

/** Problems in one file: each literal, and each run of literals joined by `+`, after SQL `||` joins are merged. */
export const sqlProblems = (source: string): string[] => {
  const pieces = literals(source);
  const texts: string[] = [];
  let run = '';
  pieces.forEach((p, k) => {
    texts.push(p.text);
    const prev = pieces[k - 1];
    run = prev !== undefined && /^\s*\+\s*$/.test(source.slice(prev.end, p.start)) ? run + p.text : p.text;
    texts.push(run);
  });
  return [...new Set(texts)].flatMap((t) => {
    const merged = t.replace(/(['"])\s*\|\|\s*\1/g, '');
    return NONDETERMINISTIC_SQL.filter((re) => re.test(merged)).map((re) => `${re.source} in "${t.trim().slice(0, 60)}"`);
  });
};

const files = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));

describe('ledger SQL never reads the clock, randomness or another file', () => {
  it('every string in ledger/**, adapters/ included, is clean', () => {
    const all = files(LEDGER);
    expect(all.some((f) => f.includes('/adapters/'))).toBe(true);
    const found = all.flatMap((f) => sqlProblems(readFileSync(f, 'utf8')).map((p) => `${relative(LEDGER, f)}: ${p}`));
    expect(found).toEqual([]);
  });

  it('catches every planted case, including split spellings, and leaves clean SQL and comments alone', () => {
    const bad = [
      "db.exec('SELECT datetime(\\'now\\')');",
      'db.exec("ATTACH \'scoring.db\' AS s");',
      "db.exec(`DETACH s`);",
      "const t = 'SELECT CURRENT_TIMESTAMP';",
      "const r = `SELECT random()`;",
      "const b = 'SELECT randomblob(8)';",
      "const u = 'SELECT unixepoch()';",
      "const f = \"SELECT strftime('%s')\";",
      "const s = 'SELECT ' + 'n' + 'ow';",
      "const q = \"SELECT 'n' || 'ow'\";",
      "const a = 'ATT' + 'ACH x';",
      'const p = `INSERT INTO t VALUES (${x}, julianday())`;',
    ];
    for (const snippet of bad) expect(sqlProblems(snippet), snippet).not.toEqual([]);
    const ok = [
      "db.prepare('SELECT * FROM fill WHERE intent_id = ? ORDER BY fill_id');",
      "const d = 'SELECT datetime(ts / 1000, \\'unixepoch\\') FROM t';",
      '// never ATTACH or read now() here',
      '/* SELECT random() */ const x = 1;',
      'const re = /\'now\'/; const y = 2;',
      "const known = 'acknowledged';",
    ];
    for (const snippet of ok) expect(sqlProblems(snippet), snippet).toEqual([]);
  });
});
