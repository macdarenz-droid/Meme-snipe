// Guard: core code never reads the wall clock, draws unseeded randomness, starts timers, or touches the
// network or the file system. Only folders named `adapters` may (docs/ARCHITECTURE.md §16.1).
// Extend FORBIDDEN when a new way in appears; never remove from it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

const IO_MODULES = [
  'fs', 'fs/promises', 'net', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises', 'tls', 'child_process', 'cluster',
  'worker_threads', 'timers', 'timers/promises', 'perf_hooks', 'readline', 'inspector', 'os', 'process', 'module', 'vm',
  'undici', 'ws', 'axios', 'node-fetch',
].map((m) => m.replace('/', '\\/')).join('|');

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'Date.now', pattern: /\bDate\s*\.\s*now\b/ },
  { name: 'new Date() without an argument', pattern: /\bnew\s+Date\s*\(\s*\)/ },
  { name: 'Date() called for the current time', pattern: /(?<![\w.$]|new\s)Date\s*\(\s*\)/ },
  { name: 'Math.random', pattern: /\bMath\s*\.\s*random\b/ },
  { name: 'performance.now', pattern: /\bperformance\s*\.\s*now\b/ },
  { name: 'process clock', pattern: /\bprocess\s*\.\s*(hrtime|uptime|cpuUsage)\b/ },
  { name: 'timer', pattern: /\b(setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|requestAnimationFrame)\b/ },
  { name: 'network', pattern: /\b(fetch|WebSocket|XMLHttpRequest|EventSource|WebTransport|RTCPeerConnection)\b/ },
  { name: 'crypto randomness', pattern: /\b(randomBytes|randomUUID|randomInt|randomFill|randomFillSync|getRandomValues|generateKeyPair)\b/ },
  { name: 'I/O module import', pattern: new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"](?:node:)?(?:${IO_MODULES})['"]`) },
  { name: 'dynamic import or require', pattern: /\bimport\s*\(|\brequire\s*\(/ },
  { name: 'global escape hatch', pattern: /\b(globalThis|eval|Function)\s*[([.]/ },
];

/** Removes comments so prose may mention what code may not do. Strings are kept and scanned. */
const stripComments = (source: string): string => {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
    out += c;
    i++;
  }
  return out;
};

const scan = (source: string): string[] => {
  const code = stripComments(source);
  return FORBIDDEN.filter((f) => f.pattern.test(code)).map((f) => f.name);
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'adapters' ? [] : sourceFiles(path);
    return /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/.test(d.name) ? [path] : [];
  });

describe('purity guard', () => {
  it('flags every forbidden way to reach the clock, randomness, timers, network or files', () => {
    const bad: Record<string, string> = {
      'Date.now': 'const t = Date.now();',
      'new Date() without an argument': 'const d = new Date();',
      'Date() called for the current time': 'const s = Date();',
      'Math.random': 'const r = Math.random();',
      'performance.now': 'const p = performance.now();',
      'process clock': 'const h = process.hrtime.bigint();',
      timer: 'setTimeout(() => {}, 10);',
      network: "await fetch('https://example.com');",
      'crypto randomness': "import { randomUUID } from 'node:crypto'; randomUUID();",
      'I/O module import': "import { readFileSync } from 'node:fs';",
      'dynamic import or require': "const m = await import('./x.ts');",
      'global escape hatch': "globalThis['Date'].now();",
    };
    for (const [name, snippet] of Object.entries(bad)) expect(scan(snippet), snippet).toContain(name);
    expect(scan("import * as fs from 'fs';")).toContain('I/O module import');
    expect(scan("import net from 'node:net';")).toContain('I/O module import');
    expect(scan('const ws = new WebSocket(url);')).toContain('network');
    expect(scan('setInterval(f, 1)')).toContain('timer');
  });

  it('allows what is deterministic: dates from data, hashing, and prose in comments', () => {
    const ok = [
      'const d = new Date(eventTime);',
      "import { createHash } from 'node:crypto';",
      '// never call Date.now or Math.random here',
      '/* setTimeout belongs in adapters */ const x = 1;',
      'const updatedAt = row.date();',
      'const fetched = true; const dateNow = 1;',
    ];
    for (const snippet of ok) expect(scan(snippet), snippet).toEqual([]);
  });

  it('packages/core/src outside adapters folders has none of them', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.some((f) => f.includes(`${sep}engine${sep}`))).toBe(true);
    const found = files.flatMap((f) => scan(readFileSync(f, 'utf8')).map((name) => `${relative(SRC, f)}: ${name}`));
    expect(found).toEqual([]);
  });
});
