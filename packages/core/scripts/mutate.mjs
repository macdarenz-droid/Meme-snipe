// Small mutation runner (EXIT-1): one mutant per run over a source folder; the folder's tests must fail to kill it.
// Usage: node packages/core/scripts/mutate.mjs <src dir> <test dir> [file filter]
//   e.g. node packages/core/scripts/mutate.mjs packages/core/src/exits packages/core/test/exits
// No dependency: it copies packages/core into temp workers and runs the repo's vitest there.
// Operators: relational and equality boundaries/negations, logical and/or, arithmetic, numeric literals ±1,
// boolean flips, removed `!`, and if-conditions forced true/false. Strings, templates and comments are never touched.
// A mutant whose run fails on a syntax or transform error is reported as `error`, not as killed.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const DIR = process.argv[2] ?? 'packages/core/src/exits';
const TESTS = process.argv[3] ?? 'packages/core/test/exits';
const WORKERS = Number(process.env.WORKERS ?? 4);
const only = process.argv[4] ?? null;

/** Code ranges outside comments, strings and templates. */
export const codeMask = (src) => {
  const mask = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (q === '`' && depth > 0 && src[i] === '}') { depth--; i++; continue; }
        if (src[i] === q && depth === 0) { i++; break; }
        i++;
      }
      continue;
    }
    mask[i] = 1; i++;
  }
  return mask;
};

const lineOf = (src, pos) => src.slice(0, pos).split('\n').length;

export const mutantsOf = (file, src) => {
  const mask = codeMask(src);
  const out = [];
  const isCode = (a, b) => { for (let k = a; k < b; k++) if (!mask[k]) return false; return true; };
  const add = (start, end, rep, op) => { if (isCode(start, end)) out.push({ file, start, end, rep, op, line: lineOf(src, start), orig: src.slice(start, end) }); };
  // Skip import/export-from lines and type declarations.
  const skipLine = (pos) => {
    const ls = src.lastIndexOf('\n', pos - 1) + 1;
    const le = src.indexOf('\n', pos);
    const line = src.slice(ls, le < 0 ? src.length : le);
    return /^\s*(import|export \*|export \{.*\} from|export type|type |readonly |\| \{|  \| )/.test(line) || /^\s*\|/.test(line);
  };
  const binary = { ' < ': [' <= ', ' >= '], ' <= ': [' < ', ' > '], ' > ': [' >= ', ' <= '], ' >= ': [' > ', ' < '],
    ' === ': [' !== '], ' !== ': [' === '], ' && ': [' || '], ' || ': [' && '], ' + ': [' - '], ' - ': [' + '], ' * ': [' / '], ' / ': [' * '] };
  for (const [op, reps] of Object.entries(binary)) {
    let p = src.indexOf(op);
    while (p >= 0) {
      if (!skipLine(p)) for (const r of reps) add(p, p + op.length, r, `${op.trim()}→${r.trim()}`);
      p = src.indexOf(op, p + 1);
    }
  }
  for (const m of src.matchAll(/(?<![\w$.])(\d[\d_]*)(n?)(?![\w$.])/g)) {
    if (skipLine(m.index)) continue;
    const v = BigInt(m[1].replaceAll('_', ''));
    add(m.index, m.index + m[0].length, `${v + 1n}${m[2]}`, 'literal+1');
    if (v > 0n) add(m.index, m.index + m[0].length, `${v - 1n}${m[2]}`, 'literal-1');
  }
  for (const m of src.matchAll(/\b(true|false)\b/g)) {
    if (skipLine(m.index)) continue;
    add(m.index, m.index + m[0].length, m[0] === 'true' ? 'false' : 'true', 'boolean');
  }
  for (const m of src.matchAll(/!(?=[\w(])/g)) {
    if (skipLine(m.index)) continue;
    add(m.index, m.index + 1, '', 'remove !');
  }
  for (const m of src.matchAll(/\bif \(/g)) {
    // The same mask as every other operator: an `if (` in a comment or string is not code, and a parenthesis in a
    // string inside the condition does not count towards its end.
    if (!isCode(m.index, m.index + m[0].length)) continue;
    let d = 1; let k = m.index + m[0].length;
    while (d > 0 && k < src.length) { if (mask[k] && src[k] === '(') d++; else if (mask[k] && src[k] === ')') d--; k++; }
    if (d > 0) continue;
    const a = m.index + m[0].length; const b = k - 1;
    out.push({ file, start: a, end: b, rep: 'true', op: 'if→true', line: lineOf(src, a), orig: src.slice(a, b) });
    out.push({ file, start: a, end: b, rep: 'false', op: 'if→false', line: lineOf(src, a), orig: src.slice(a, b) });
  }
  return out;
};

const main = async () => {
const SP = mkdtempSync(join(tmpdir(), 'mutate-'));
const files = readdirSync(join(REPO, DIR)).filter((f) => f.endsWith('.ts')).map((f) => join(DIR, f));
let mutants = files.flatMap((f) => mutantsOf(f, readFileSync(join(REPO, f), 'utf8')));
if (only) mutants = mutants.filter((m) => m.file.endsWith(only));

// Worker copies: packages/core plus the root config, sharing node_modules.
const work = join(SP, 'mut');
rmSync(work, { recursive: true, force: true });
for (let w = 0; w < WORKERS; w++) {
  const d = join(work, `w${w}`);
  mkdirSync(join(d, 'packages'), { recursive: true });
  cpSync(join(REPO, 'packages/core'), join(d, 'packages/core'), { recursive: true, filter: (s) => !s.includes('node_modules') });
  if (existsSync(join(REPO, 'packages/core/node_modules'))) symlinkSync(join(REPO, 'packages/core/node_modules'), join(d, 'packages/core/node_modules'));
  symlinkSync(join(REPO, 'node_modules'), join(d, 'node_modules'));
  cpSync(join(REPO, 'package.json'), join(d, 'package.json'));
  cpSync(join(REPO, 'tsconfig.base.json'), join(d, 'tsconfig.base.json'));
  writeFileSync(join(d, 'vitest.config.ts'), `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['${TESTS}/**/*.test.ts'], setupFiles: ['packages/core/test/setup.ts'] } });\n`);
}

const run = (dir) => new Promise((resolve) => {
  const p = spawn(join(REPO, 'node_modules/.bin/vitest'), ['run', '--bail', '1'], { cwd: dir, env: { ...process.env, CI: '1' } });
  let text = '';
  p.stdout.on('data', (b) => { text += b; });
  p.stderr.on('data', (b) => { text += b; });
  p.on('close', (code) => resolve({ code, text }));
});

const results = [];
let next = 0;
const worker = async (w) => {
  const d = join(work, `w${w}`);
  while (next < mutants.length) {
    const m = mutants[next++];
    const path = join(d, m.file);
    const orig = readFileSync(join(REPO, m.file), 'utf8');
    writeFileSync(path, orig.slice(0, m.start) + m.rep + orig.slice(m.end));
    const r = await run(d);
    writeFileSync(path, orig);
    const syntax = /SyntaxError|Transform failed|Failed to parse|ERR_INVALID_TYPESCRIPT_SYNTAX|Unexpected token/.test(r.text) && !/AssertionError/.test(r.text);
    results.push({ ...m, status: r.code === 0 ? 'survived' : syntax ? 'error' : 'killed' });
  }
};
await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
results.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
const by = (s) => results.filter((r) => r.status === s);
writeFileSync(join(SP, 'mutants.json'), JSON.stringify(results, null, 1));
rmSync(work, { recursive: true, force: true });
for (const r of by('survived')) console.log(`SURVIVED ${r.file}:${r.line} ${r.op}  [${r.orig}] → [${r.rep}]`);
for (const r of by('error')) console.log(`ERROR ${r.file}:${r.line} ${r.op}`);
console.log(`total ${results.length} killed ${by('killed').length} survived ${by('survived').length} error ${by('error').length}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
