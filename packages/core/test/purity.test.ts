// Guard: core code never reads the wall clock, draws unseeded randomness, schedules work, reads the
// environment, or touches the network or the file system. Only folders named `adapters` may
// (docs/ARCHITECTURE.md §16.1). Bans are by identifier over a token stream, not by call shape, so
// spellings such as `Date['now']()`, `+new Date` or `const { random } = Math` are caught too.
// Extend the lists when a new way in appears; never remove from them.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** Identifiers that reach the clock, randomness, scheduling, the environment, I/O or code generation. */
const BANNED_IDENTIFIERS = new Set([
  'performance', 'process', 'Intl', 'queueMicrotask', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout',
  'clearInterval', 'clearImmediate', 'requestAnimationFrame', 'requestIdleCallback', 'Atomics', 'fetch', 'WebSocket',
  'XMLHttpRequest', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'Worker', 'navigator', 'document', 'location',
  'localStorage', 'sessionStorage', 'indexedDB', 'globalThis', 'global', 'window', 'self', 'eval', 'Function', 'require',
  'module', 'Deno', 'Bun', 'random', 'randomBytes', 'randomUUID', 'randomInt', 'randomFill', 'randomFillSync',
  'getRandomValues', 'generateKeyPair', 'generateKeyPairSync', 'getBuiltinModule', 'WeakRef', 'FinalizationRegistry', 'crypto',
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
  // Locale and time-zone reads differ between machines and would break replay-versus-live parity.
  'getTimezoneOffset', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
  'getMilliseconds', 'getYear', 'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds',
  'setMilliseconds', 'setYear', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toLocaleUpperCase',
  'toLocaleLowerCase', 'localeCompare', 'toDateString', 'toTimeString',
]);

/** Built-in globals. Reflection on them (`Reflect.*`, property descriptors) is how a ban-list gets bypassed. */
const GLOBAL_OBJECTS = new Set([
  'Math', 'Date', 'Intl', 'JSON', 'Object', 'Reflect', 'Number', 'String', 'Array', 'BigInt', 'Symbol', 'Proxy', 'Promise',
  'Atomics', 'crypto', 'console', 'process', 'performance', 'globalThis', 'Function',
]);

/**
 * Inside ledger/: SQL that reads the clock, draws randomness or opens another database file. Applied to each
 * string after adjacent pieces joined by `+` (JS) or `||` (SQL) are merged, so `'n' || 'ow'` is caught too.
 */
const NONDETERMINISTIC_SQL: readonly RegExp[] = [
  /\bnow\b/i, // 'now', "now" (SQLite reads a double-quoted unknown name as a string), now()
  /\bcurrent_(timestamp|date|time)\b/i,
  /\b(datetime|date|time|julianday|unixepoch)\s*\(\s*\)/i, // no argument: the current time
  /\bstrftime\s*\(\s*(['"])[^'"]*\1\s*\)/i, // a format with no time value: the current time
  /\brandom(blob)?\s*\(/i,
  /\b(attach|detach)\b/i,
];
const sqlReadsTheWorld = (text: string): boolean => {
  const merged = text.replace(/(['"])\s*\|\|\s*\1/g, '');
  return NONDETERMINISTIC_SQL.some((re) => re.test(merged));
};

/**
 * A module path into the outcome side: the ledger, the scoring stage and labels. Only ledger/ and stats/ may
 * name one; the engine, strategies and everything else reach the ledger through the EffectRunner or an adapter,
 * and never read scored outcomes (docs/ARCHITECTURE.md §16.1).
 */
const OUTCOME_PATH = /(^|\/)(ledger|stats|labels|scoring)(\/|\.ts$|$)/;
const OUTCOME_FOLDERS = new Set(['ledger', 'stats']);

/** The only `Math` members core may use, always as `Math.<name>`: pure functions and constants. */
const MATH_ALLOWED = new Set([
  'abs', 'min', 'max', 'floor', 'ceil', 'round', 'trunc', 'sign', 'imul', 'clz32', 'fround', 'pow', 'sqrt', 'cbrt',
  'hypot', 'log', 'log2', 'log10', 'log1p', 'exp', 'expm1', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2',
]);

/** Extra bans per folder. The engine is synchronous by design: results come back as feed events. */
const FOLDER_BANS: Readonly<Record<string, ReadonlySet<string>>> = {
  engine: new Set(['async', 'await', 'Promise', 'then']),
};

/**
 * Narrow, named exemptions: a folder may use exactly these banned strings, nothing else.
 * ledger/ is the SQLite ledger (LEDGER-1); its scoring reader lives in ledger/scoring.
 */
const EXEMPTIONS: readonly { readonly folder: string; readonly allow: ReadonlySet<string>; readonly why: string }[] = [
  { folder: 'ledger', allow: new Set(['node:sqlite']), why: 'LEDGER-1: append-only SQLite ledger and its scoring reader' },
];

/** String literals that name a banned thing: computed access (`Math['random']`), `Reflect.get`, or a module import. */
const BANNED_STRINGS = new Set([
  ...BANNED_IDENTIFIERS, 'now', 'Date', 'Math', 'timeOrigin', 'nextTick', 'hrtime', 'env',
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
    // At the character after ` or }. Reads text up to the next ${ or closing `; the text is kept for the SQL check.
    let text = '';
    while (i < source.length) {
      const c = source[i]!;
      if (c === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') { i++; tokens.push({ type: 'template', value: text }); return; }
      if (c === '$' && source[i + 1] === '{') {
        i += 2;
        braces.push('template');
        tokens.push({ type: 'template', value: text }, { type: 'punct', value: '${' });
        return;
      }
      text += c;
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

const scan = (source: string, allow: ReadonlySet<string> = new Set(), folderBans: ReadonlySet<string> = new Set(), context: { readonly folder: string } = { folder: '' }): string[] => {
  const { tokens, problems } = tokenize(source);
  const found = [...problems];
  tokens.forEach((t, k) => {
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (t.type === 'id') {
      const property = prev?.value === '.' || prev?.value === '?.' || prev?.value === '#';
      // An object key, or a member declared in a type (`readonly global: X;`): a name, not a reference.
      const key = (next?.value === ':' || (next?.value === '?' && tokens[k + 2]?.value === ':')) && (prev?.value === '{' || prev?.value === ',' || prev?.value === ';' || prev?.value === 'readonly');
      if (property ? BANNED_PROPERTIES.has(t.value) : !key && BANNED_IDENTIFIERS.has(t.value)) found.push(t.value);
      // No Date at all: times are integer milliseconds from data. This also rules out Date.parse and local-time reads.
      if (t.value === 'Date' && !property && !key) found.push('Date (times are integer ms)');
      // Math only as `Math.<allowed>`, so it cannot be aliased, reflected or indexed into.
      if (t.value === 'Math' && !property && !key && !(next?.value === '.' && MATH_ALLOWED.has(tokens[k + 2]?.value ?? ''))) found.push('Math outside its allow-list');
      if (folderBans.has(t.value)) found.push(`${t.value} in this folder`);
      if (t.value === 'import' && !property && (next?.value === '(' || next?.value === '.')) found.push('dynamic import or import.meta');
    }
    if (t.type === 'id' && t.value === 'Reflect' && !(next?.value === '.' && tokens[k + 2]?.value === 'ownKeys')) found.push('Reflect beyond ownKeys');
    if (t.type === 'id' && (t.value === 'getOwnPropertyDescriptor' || t.value === 'getOwnPropertyDescriptors') && next?.value === '(' && GLOBAL_OBJECTS.has(tokens[k + 2]?.value ?? '')) {
      found.push('property descriptor of a global');
    }
    if (t.type === 'str' && BANNED_STRINGS.has(t.value) && !allow.has(t.value)) found.push(`string '${t.value}'`);
    // A computed member key must be one literal (or an identifier): `x['con' + 'structor']` or `x[`${a}b`]` is how
    // a banned name is spelled past this scanner.
    if (t.value === '[' && t.type === 'punct' && prev !== undefined && (prev.type === 'id' || prev.type === 'str' || prev.type === 'template' || prev.value === ')' || prev.value === ']' || prev.value === '?.')
      && (next?.type === 'str' || next?.type === 'template') && tokens[k + 2]?.value !== ']') {
      found.push('computed member key built from pieces');
    }
    // `x['constructor']` reaches the Function constructor; a 'constructor' in a plain data list (a set of
    // keys to refuse) is not an access and stays legal. Computed spellings are left to the runtime trap.
    if ((t.type === 'str' || t.type === 'template') && t.value === 'constructor' && prev?.value === '[' && next?.value === ']') {
      const before = tokens[k - 2];
      if (before !== undefined && (before.type === 'id' || before.type === 'str' || before.type === 'template' || before.value === ')' || before.value === ']' || before.value === '?.')) {
        found.push("['constructor'] access");
      }
    }
    if ((t.type === 'str' || t.type === 'template') && !OUTCOME_FOLDERS.has(context.folder) && OUTCOME_PATH.test(t.value)) found.push('reaches into the outcome side');

  });
  if (context.folder === 'ledger') {
    // Strings joined with + are checked as one, so a value split across pieces cannot hide.
    for (let k = 0; k < tokens.length; k++) {
      if (tokens[k]!.type !== 'str' && tokens[k]!.type !== 'template') continue;
      let text = tokens[k]!.value;
      while (tokens[k + 1]?.value === '+' && (tokens[k + 2]?.type === 'str' || tokens[k + 2]?.type === 'template')) {
        text += tokens[k + 2]!.value;
        k += 2;
      }
      if (sqlReadsTheWorld(text)) found.push('SQL reading the clock or randomness');
    }
  }
  return found;
};

const topFolder = (file: string): string => relative(SRC, file).split(sep)[0] ?? '';
const allowedFor = (file: string): ReadonlySet<string> => EXEMPTIONS.find((e) => e.folder === topFolder(file))?.allow ?? new Set();
const folderBansFor = (file: string): ReadonlySet<string> => FOLDER_BANS[topFolder(file)] ?? new Set();

/** Module specifiers a file imports or re-exports (static forms only; dynamic import is banned). */
const specifiers = (source: string): string[] => {
  const { tokens } = tokenize(source);
  const out: string[] = [];
  tokens.forEach((t, k) => {
    if (t.type !== 'str') return;
    const prev = tokens[k - 1]?.value;
    if (prev === 'from' || (prev === 'import' && tokens[k - 2]?.value !== '.')) out.push(t.value);
  });
  return out;
};

/** Resolves a specifier to a file under src (relative paths and this package's own subpaths), or null for outside modules. */
const resolveModule = (from: string, spec: string, files: ReadonlySet<string>): string | null => {
  const self = /^@meme-snipe\/core(?:\/(.+))?$/.exec(spec);
  const base = self ? join(SRC, self[1] ?? '', 'index.ts') : spec.startsWith('.') ? normalize(join(dirname(from), spec)) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) if (files.has(candidate)) return candidate;
  return base;
};

/** Every import chain from a file outside ledger/ and stats/ (engine, strategies, adapters, anything) into one of them. `sources` maps absolute paths under src to file text. */
const outcomeReaches = (sources: ReadonlyMap<string, string>): string[] => {
  const files = new Set(sources.keys());
  const edges = new Map([...sources].map(([f, text]) => [f, specifiers(text).map((sp) => resolveModule(f, sp, files)).filter((x): x is string => x !== null)]));
  const found: string[] = [];
  for (const start of files) {
    if (OUTCOME_FOLDERS.has(topFolder(start))) continue;
    const seen = new Set<string>([start]);
    const stack: string[][] = [[start]];
    while (stack.length > 0) {
      const chain = stack.pop()!;
      for (const next of edges.get(chain[chain.length - 1]!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const path = [...chain, next];
        if (OUTCOME_FOLDERS.has(topFolder(next))) found.push(path.map((f) => relative(SRC, f)).join(' -> '));
        else stack.push(path);
      }
    }
  }
  return found;
};

const allSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return allSourceFiles(path);
    return /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/.test(d.name) ? [path] : [];
  });

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
      "((() => 0) as never)['constructor']('return Date.n' + 'ow()')();",
      "((() => 0) as never)['con' + 'structor']('return Date.n' + 'ow()')();",
      "const e = ((() => 0) as never)['con' + 'structor']('return pro' + 'cess.en' + 'v.HOME')();",
      'const v = obj[`con${x}`];',
      "const v = obj?.['a' + b];",
      "const f = obj['constructor'];",
      "const f = obj?.['constructor'];",
      'const f = obj[`constructor`];',
      "const F = Function; const g = new Function('return 1');",
      'const re = /a\\//; const t = Date.now();',
      'const re = /[/]/; const t = Date.now();',
      'const t = `${Date.now()}`;',
      'const t = `a${`b${Math.random()}`}`;',
      'const x = \\u0044ate.now();',
      'const x = foo.random();',
      'const d = new Date(eventTime);',
      'const t = new Date(...[]);',
      "const t = Date.parse('2026-01-01');",
      "Object.getOwnPropertyDescriptor(Math, 'ran' + 'dom')!.value();",
      "Reflect.get(Math, 'ran' + 'dom')();",
      "const M = Math as never; M['ran' + 'dom']();",
      'const z = d.getTimezoneOffset();',
      'const h = d.getHours();',
      'd.setMinutes(0);',
      'const s = n.toLocaleString();',
      'const c = a.localeCompare(b);',
      'const u = s.toLocaleUpperCase();',
      'const s = d.toDateString() + d.toTimeString();',
      "const v = Reflect.apply(Math.max, null, []); const g = Reflect.get(o, 'k');",
      "const d = Object.getOwnPropertyDescriptor(Date, 'now');",
      'const ds = Object.getOwnPropertyDescriptors(Math);',
      'const b = crypto.getRandomValues(new Uint8Array(4));',
      'const fmt = Intl.NumberFormat;',
      "const f = obj.getBuiltinModule('x');",
      'const p = performance;',
      'const k = { a: process };',
      'const n = a ? performance : 0;',
    ];
    for (const snippet of bad) expect(scan(snippet), snippet).not.toEqual([]);
  });

  it('allows what is deterministic: dates from data, hashing, prose in comments, division', () => {
    const ok = [
      "import { createHash } from 'node:crypto';",
      'const m = Math.max(a, Math.floor(b / 2)) + Math.PI;',
      'const s = (10n).toString(); const u = d.getUTCHours();',
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
      'interface Ctx { readonly global: G; window?: number; self: S }',
      "const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);",
      "const keys = ['constructor'];",
      "const v = obj['key']; const w = arr[0]; const x = map[id]; const y = [['a' + b]];",
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

  it('the ledger is reached only through the effect runner, and its SQL is deterministic', () => {
    // The reviewer's probes: an engine file importing a ledger helper that runs julianday('now') and random().
    const use = "import { now } from '../ledger/zz_db.ts'; export const t = now();";
    expect(scan(use, new Set(), new Set(), { folder: 'engine' })).toContain('reaches into the outcome side');
    expect(scan("import { labels } from '../ledger/scoring/index.ts';", new Set(), new Set(), { folder: 'engine' })).toContain('reaches into the outcome side');
    expect(scan("import { x } from '@meme-snipe/core/ledger';", new Set(), new Set(), { folder: 'engine' })).toContain('reaches into the outcome side');
    for (const path of ['../stats/labels.ts', '@meme-snipe/core/stats', '../labels/index.ts', './scoring/x.ts', '../x/labels.ts']) {
      for (const folder of ['engine', 'strategy', 'domain']) {
        expect(scan(`import { y } from '${path}';`, new Set(), new Set(), { folder }), `${folder}: ${path}`).toContain('reaches into the outcome side');
      }
    }
    expect(scan("import { y } from '../ledger/scoring/index.ts';", new Set(), new Set(), { folder: 'stats' })).toEqual([]);
    const db = "import { DatabaseSync } from 'node:sqlite'; export { DatabaseSync }; export const now = (db: DatabaseSync) => db.prepare(`select julianday('now'), random()`).get();";
    const ledger = join(SRC, 'ledger', 'zz_db.ts');
    expect(scan(db, allowedFor(ledger), folderBansFor(ledger), { folder: 'ledger' })).toContain('SQL reading the clock or randomness');
    for (const sql of [
      "'select datetime()'", "'select date( )'", "'select time()'", "'select julianday()'", "'select unixepoch()'",
      "\"select strftime('%s')\"", "'select julianday(\"now\")'", "\"select julianday('n'||'ow')\"",
      "\"select julianday('n' || 'ow')\"", "\"select julianday('\" + \"n\" + \"ow')\"", "\"attach database 'x.db' as x\"",
      "'DETACH x'", "'select now()'", "'select randomblob(8)'", "'insert into t values (current_timestamp)'", '`select current_date`', "\"select datetime('now')\""]) {
      expect(scan(`const q = ${sql};`, allowedFor(ledger), new Set(), { folder: 'ledger' }), sql).toContain('SQL reading the clock or randomness');
    }
    for (const sql of ["'select datetime(?, ?)'", "\"select strftime('%s', ?)\"", "'insert into fills (slot, at) values (?, ?)'", "'select known from t'"]) {
      expect(scan(`const q = ${sql};`, allowedFor(ledger), new Set(), { folder: 'ledger' }), sql).toEqual([]);
    }
    // Inside ledger/, its own modules are fine; outside, words such as "ledgers" in prose strings are not paths.
    expect(scan("import { codec } from './codec.ts'; import { x } from '../ledger/sqlite.ts';", allowedFor(ledger), new Set(), { folder: 'ledger' })).toEqual([]);
    expect(scan("const s = 'the ledger file';", new Set(), new Set(), { folder: 'engine' })).toEqual([]);
  });

  it('nothing outside ledger/ and stats/ (engine, strategies, adapters) reaches them through any chain of imports or re-exports', () => {
    // The reviewer's re-export case, routed through an adapter so the import text names no ledger path.
    const probe = new Map([
      [join(SRC, 'engine', 'zz_use.ts'), "import { now } from '../adapters/zz_bridge.ts'; export const t = now();"],
      [join(SRC, 'adapters', 'zz_bridge.ts'), "export { now } from '../ledger/zz_db.ts';"],
      [join(SRC, 'ledger', 'zz_db.ts'), "export { DatabaseSync } from 'node:sqlite'; export const now = () => 1;"],
      [join(SRC, 'engine', 'zz_stats.ts'), "import { gate } from '@meme-snipe/core/stats';"],
      [join(SRC, 'stats', 'index.ts'), 'export const gate = 1;'],
      [join(SRC, 'engine', 'ok.ts'), "import { x } from '../units/index.ts';"],
      // Strategies are injected, never imported by the engine; they are walked too.
      [join(SRC, 'strategy', 'zz_s.ts'), "import { labels } from '../stats/labels.ts';"],
      [join(SRC, 'stats', 'labels.ts'), 'export const labels = 1;'],
      [join(SRC, 'domain', 'zz_re.ts'), "export * from '../ledger/zz_db.ts';"],
      [join(SRC, 'units', 'index.ts'), 'export const x = 1;'],
    ]);
    const chains = outcomeReaches(probe);
    expect(chains).toContain(['engine/zz_use.ts', 'adapters/zz_bridge.ts', 'ledger/zz_db.ts'].join(' -> ').replaceAll('/', sep));
    expect(chains).toContain(['engine/zz_stats.ts', 'stats/index.ts'].join(' -> ').replaceAll('/', sep));
    expect(chains).toContain(['strategy/zz_s.ts', 'stats/labels.ts'].join(' -> ').replaceAll('/', sep));
    expect(chains).toContain(['domain/zz_re.ts', 'ledger/zz_db.ts'].join(' -> ').replaceAll('/', sep));
    expect(chains.some((c) => c.startsWith(join('engine', 'ok.ts')))).toBe(false);
    // The real tree, adapters included.
    const real = new Map(allSourceFiles(SRC).map((f) => [f, readFileSync(f, 'utf8')] as const));
    expect(outcomeReaches(real)).toEqual([]);
  });

  it('config/ has no exemption: the Function constructor escape is flagged there too', () => {
    const cfg = join(SRC, 'config', 'zz_fn.ts');
    const probe = "export const t = ((() => 0) as never)['constructor']('return Date.n' + 'ow()')();";
    expect(scan(probe, allowedFor(cfg), folderBansFor(cfg), { folder: 'config' })).not.toEqual([]);
    expect(EXEMPTIONS.some((e) => e.folder === 'config')).toBe(false);
  });

  it('the engine folder also bans asynchronous code', () => {
    const engine = folderBansFor(join(SRC, 'engine', 'x.ts'));
    for (const snippet of ['async function f() {}', 'await x;', 'Promise.resolve(1);', 'p.then(f);']) expect(scan(snippet, new Set(), engine), snippet).not.toEqual([]);
    expect(scan('p.then(f);', new Set(), folderBansFor(join(SRC, 'ledger', 'x.ts')))).toEqual([]);
  });

  it('packages/core/src outside adapters folders has none of them', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.some((f) => f.includes(`${sep}engine${sep}`))).toBe(true);
    const found = files.flatMap((f) => scan(readFileSync(f, 'utf8'), allowedFor(f), folderBansFor(f), { folder: topFolder(f) }).map((name) => `${relative(SRC, f)}: ${name}`));
    expect(found).toEqual([]);
  });
});
