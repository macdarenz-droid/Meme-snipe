// Guard: core code never reads the wall clock, draws unseeded randomness, schedules work, reads the
// environment, or touches the network or the file system. Only folders named `adapters` may
// (docs/ARCHITECTURE.md §16.1). Bans are by identifier over a token stream, not by call shape, so
// spellings such as `Date['now']()`, `+new Date` or `const { random } = Math` are caught too.
// Extend the lists when a new way in appears; never remove from them.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** Identifiers that reach the clock, randomness, scheduling, the environment, I/O or code generation. */
const BANNED_IDENTIFIERS = new Set([
  'performance', 'process', 'Intl', 'queueMicrotask', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout',
  'clearInterval', 'clearImmediate', 'requestAnimationFrame', 'requestIdleCallback', 'Atomics', 'fetch', 'WebSocket',
  'XMLHttpRequest', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'Worker', 'navigator', 'document', 'location',
  'localStorage', 'sessionStorage', 'indexedDB', 'globalThis', 'global', 'window', 'self', 'eval', 'Function', 'require',
  'module', 'Deno', 'Bun', 'random', 'randomBytes', 'randomUUID', 'randomInt', 'randomFill', 'randomFillSync',
  'getRandomValues', 'generateKeyPair', 'generateKeyPairSync', 'getBuiltinModule', 'WeakRef', 'FinalizationRegistry',
]);

const IO_MODULES = [
  'fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises', 'tls', 'child_process', 'cluster',
  'worker_threads', 'timers', 'timers/promises', 'perf_hooks', 'readline', 'inspector', 'os', 'process', 'module', 'vm',
  'v8', 'async_hooks', 'diagnostics_channel', 'sqlite', 'undici', 'ws', 'axios', 'node-fetch',
];

/**
 * Property names that reach randomness, module loading or code generation from any object. Other
 * banned names are only references to globals: after a dot (`db.location()`), as an object key
 * (`{ self: 1 }`) or as a private field they cannot reach the global, which is unreachable anyway
 * because `globalThis`, `window`, `self` and `global` are banned as references.
 */
const BANNED_PROPERTIES = new Set([
  'random', 'randomBytes', 'randomUUID', 'randomInt', 'randomFill', 'randomFillSync', 'getRandomValues', 'generateKeyPair',
  'generateKeyPairSync', 'getBuiltinModule', 'constructor', 'nextTick', 'hrtime', 'timeOrigin',
]);

/**
 * Narrow, named exemptions: a folder may use exactly these banned strings, nothing else.
 * ledger/ is the SQLite ledger (LEDGER-1); its scoring reader lives in ledger/scoring.
 */
const EXEMPTIONS: readonly { readonly folder: string; readonly allow: ReadonlySet<string>; readonly why: string }[] = [
  { folder: 'ledger', allow: new Set(['node:sqlite']), why: 'LEDGER-1: append-only SQLite ledger and its scoring reader' },
];

/** String literals that name a banned thing: computed access (`Math['random']`), `Reflect.get`, or a module import. */
const BANNED_STRINGS = new Set([
  ...BANNED_IDENTIFIERS, 'now', 'constructor', 'Date', 'Math', 'timeOrigin', 'nextTick', 'hrtime', 'env',
  ...IO_MODULES, ...IO_MODULES.map((m) => `node:${m}`),
]);

type Token = { readonly type: 'id' | 'str' | 'num' | 'regex' | 'punct' | 'template'; readonly value: string };

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await', 'else', 'do']);

/**
 * A small tokenizer for our own TypeScript: skips comments and whitespace, reads strings (with escapes),
 * template literals (text skipped, `${…}` scanned), regex literals and identifiers. Anything it cannot
 * read, or an identifier written with a unicode escape, is reported rather than skipped.
 */
const tokenize = (source: string): { tokens: Token[]; problems: string[] } => {
  const tokens: Token[] = [];
  const problems: string[] = [];
  const braces: ('code' | 'template')[] = [];
  let i = 0;
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (prev === undefined) return true;
    if (prev.type === 'id') return REGEX_AFTER.has(prev.value);
    if (prev.type === 'punct') {
      // `x! / y`: a TypeScript non-null assertion ends an expression, so this is a division.
      const before = tokens[tokens.length - 2];
      if (prev.value === '!' && before !== undefined && (before.type === 'id' || before.type === 'num' || before.value === ')' || before.value === ']')) return false;
      return prev.value !== ')' && prev.value !== ']';
    }
    return false;
  };
  const readTemplate = () => {
    // At the character after ` or }. Reads text up to the next ${ or closing `.
    while (i < source.length) {
      const c = source[i]!;
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; tokens.push({ type: 'template', value: '`' }); return; }
      if (c === '$' && source[i + 1] === '{') { i += 2; braces.push('template'); tokens.push({ type: 'punct', value: '${' }); return; }
      i++;
    }
    problems.push('unterminated template literal');
  };
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) { problems.push('unterminated comment'); break; }
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let value = '';
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') { value += source[i + 1] ?? ''; i += 2; continue; }
        if (source[i] === '\n') { problems.push('unterminated string'); break; }
        value += source[i];
        i++;
      }
      i++;
      tokens.push({ type: 'str', value });
      continue;
    }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '}' && braces[braces.length - 1] === 'template') { braces.pop(); i++; readTemplate(); continue; }
    if (c === '/' && regexAllowed()) {
      let inClass = false;
      i++;
      while (i < source.length) {
        const r = source[i]!;
        if (r === '\\') { i += 2; continue; }
        if (r === '\n') { problems.push('unterminated regex'); break; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < source.length && /[a-z]/i.test(source[i]!)) i++;
      tokens.push({ type: 'regex', value: '/' });
      continue;
    }
    if (/[A-Za-z_$\\]/.test(c) || c.charCodeAt(0) > 127) {
      let value = '';
      while (i < source.length && (/[\w$\\]/.test(source[i]!) || source.charCodeAt(i) > 127)) { value += source[i]; i++; }
      if (/[\\]|[^\x00-\x7f]/.test(value)) problems.push(`identifier written with an escape or non-ASCII character: ${value}`);
      tokens.push({ type: 'id', value });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      let value = '';
      while (i < source.length && /[\w.]/.test(source[i]!)) { value += source[i]; i++; }
      tokens.push({ type: 'num', value });
      continue;
    }
    if (c === '{') braces.push('code');
    if (c === '}') braces.pop();
    const three = source.slice(i, i + 3);
    const value = three === '...' ? three : c === '?' && next === '.' ? '?.' : c;
    i += value.length;
    tokens.push({ type: 'punct', value });
  }
  return { tokens, problems };
};

const scan = (source: string, allow: ReadonlySet<string> = new Set()): string[] => {
  const { tokens, problems } = tokenize(source);
  const found = [...problems];
  tokens.forEach((t, k) => {
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (t.type === 'id') {
      const property = prev?.value === '.' || prev?.value === '?.' || prev?.value === '#';
      const key = next?.value === ':' && (prev?.value === '{' || prev?.value === ',');
      if (property ? BANNED_PROPERTIES.has(t.value) : !key && BANNED_IDENTIFIERS.has(t.value)) found.push(t.value);
      // Date only as `new Date(<argument>)`: a date from data, never the current time.
      if (t.value === 'Date' && !property && !key && !(prev?.value === 'new' && next?.value === '(' && tokens[k + 2]?.value !== ')')) found.push('Date without an argument');
      if (t.value === 'Math' && next?.value === '[') found.push('computed Math access');
      if (t.value === 'import' && !property && (next?.value === '(' || next?.value === '.')) found.push('dynamic import or import.meta');
    }
    if (t.type === 'str' && BANNED_STRINGS.has(t.value) && !allow.has(t.value)) found.push(`string '${t.value}'`);
  });
  return found;
};

const allowedFor = (file: string): ReadonlySet<string> => {
  const top = relative(SRC, file).split(sep)[0];
  return EXEMPTIONS.find((e) => e.folder === top)?.allow ?? new Set();
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'adapters' ? [] : sourceFiles(path);
    return /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/.test(d.name) ? [path] : [];
  });

describe('purity guard', () => {
  it('flags every way in, including the spellings found in review', () => {
    const bad = [
      'const t = Date.now();',
      'const d = new Date();',
      'const s = Date();',
      'const n = +new Date;',
      "const n = Date['now']();",
      'const r = Math.random();',
      'const { random } = Math;',
      "const r = Math['ran' + 'dom']();",
      "const r = Reflect.get(Math, 'random');",
      'const p = performance.now();',
      'const o = performance.timeOrigin;',
      'const h = process.hrtime.bigint();',
      "const fs = process.getBuiltinModule('node:fs');",
      'process.nextTick(f);',
      "const k = process.env['KEY'];",
      'const f = new Intl.DateTimeFormat().format();',
      'queueMicrotask(f);',
      'setTimeout(() => {}, 10);',
      'setInterval(f, 1)',
      "await fetch('https://example.com');",
      'const ws = new WebSocket(url);',
      "import { randomUUID } from 'node:crypto'; randomUUID();",
      "import { readFileSync } from 'node:fs';",
      "import * as fs from 'fs';",
      "import net from 'node:net';",
      "const m = await import('./x.ts');",
      "const g = globalThis['Date'];",
      "(() => 0).constructor('return Date.n' + 'ow()')();",
      "eval('1');",
      'const re = /a\\//; const t = Date.now();',
      'const re = /[/]/; const t = Date.now();',
      'const t = `${Date.now()}`;',
      'const t = `a${`b${Math.random()}`}`;',
      'const x = \\u0044ate.now();',
      'const x = foo.random();',
      "const f = obj.getBuiltinModule('x');",
      'const p = performance;',
      'const k = { a: process };',
      'const n = a ? performance : 0;',
    ];
    for (const snippet of bad) expect(scan(snippet), snippet).not.toEqual([]);
  });

  it('allows what is deterministic: dates from data, hashing, prose in comments, division', () => {
    const ok = [
      'const d = new Date(eventTime);',
      "import { createHash } from 'node:crypto';",
      '// never call Date.now or Math.random here',
      '/* setTimeout belongs in adapters */ const x = 1;',
      'const nowMs = clock.now().receivedAt;',
      'const half = total / 2 / count;',
      'const ratio = (a + b) / c; const y = arr[0] / 2;',
      'const s = `slot ${m.slot} of ${n}`;',
      'class A { constructor(x: number) { this.x = x; } }',
      "const label = 'random draw';",
      'const r = /^[0-9a-f]{64}$/.test(hash);',
      'const where = db.location();',
      'const o = { self: 1, location: 2 };',
      'class C { #window = 1; }',
      'const q = arr[i]! / (z + i); const t = 1;',
      'const q = f(x)! / 2;',
    ];
    for (const snippet of ok) expect(scan(snippet), snippet).toEqual([]);
  });

  it('exemptions are narrow: a folder gets exactly its named modules', () => {
    const sqlite = "import { DatabaseSync } from 'node:sqlite';";
    const ledger = join(SRC, 'ledger', 'sqlite.ts');
    expect(scan(sqlite, allowedFor(ledger))).toEqual([]);
    expect(scan(sqlite, allowedFor(join(SRC, 'engine', 'x.ts')))).not.toEqual([]);
    expect(scan("import { readFileSync } from 'node:fs';", allowedFor(ledger))).not.toEqual([]);
    expect(scan('const t = Date.now();', allowedFor(ledger))).not.toEqual([]);
    for (const e of EXEMPTIONS) expect(e.why.length).toBeGreaterThan(0);
  });

  it('packages/core/src outside adapters folders has none of them', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.some((f) => f.includes(`${sep}engine${sep}`))).toBe(true);
    const found = files.flatMap((f) => scan(readFileSync(f, 'utf8'), allowedFor(f)).map((name) => `${relative(SRC, f)}: ${name}`));
    expect(found).toEqual([]);
  });
});
