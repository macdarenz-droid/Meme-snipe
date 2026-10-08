// Runtime import check (C01 review finding R2): every module under packages/*/src is loaded in a child process with
// load-hooks.ts preloaded and code generation from strings disallowed. Zeroed's packages (the Zeroed manifest)
// are not loaded: they import each other by relative path and run code at load time, as Zeroed always has. The entry code imports each module by a string
// literal; a module the hooks refuse, or one that fails to load, is listed and the process exits 1.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { inZeroed } from '../scope.ts';
import { REPO_ROOT } from './helpers.ts';

const HOOKS = new URL('./load-hooks.ts', import.meta.url).href;
const tmp = mkdtempSync(join(tmpdir(), 'policy-load-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

/** Loads every packages/*\/src module of `root` outside Zeroed's paths under the hooks; returns the exit status and output. */
export function loadPackages(root: string): { status: number | null; stdout: string; stderr: string } {
  const files = readdirSync(join(root, 'packages')).filter((p) => !inZeroed(`packages/${p}/`))
    .flatMap((p) => sources(join(root, 'packages', p, 'src'))).sort();
  const lines = files.map((f) => {
    const url = JSON.stringify(pathToFileURL(f).href);
    return `try { await import(${url}); loaded++; } catch (e) { if (!String(e?.message).startsWith('load-hooks:')) refused.push(${JSON.stringify(f.slice(root.length + 1))} + ': ' + e.name + ': ' + e.message); }`;
  });
  const code = ["const refused = globalThis[Symbol.for('load-hooks.refused')];", 'let loaded = 0;', ...lines,
    `console.log('load-packages: ' + loaded + ' of ${files.length} modules loaded');`].join('\n');
  const r = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--import', HOOKS, '--input-type=module', '-e', code],
    { cwd: root, encoding: 'utf8', env: { ...process.env, LOAD_HOOKS_ROOT: root } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmp, 'repo-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  mkdirSync(join(root, 'node_modules'));
  for (const name of ['fast-check', 'typescript']) symlinkSync(join(REPO_ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
  return root;
}

const manifest = (name: string, dependencies: Record<string, string> = {}): string => JSON.stringify({ name, type: 'module', dependencies });

/**
 * The one warning Node 22 prints when a module loads the built-in `node:sqlite` (CA-33, B-M24-01: the persistence
 * library is that built-in, "Stability: 1.1"). Only these exact two lines are removed before stderr must be empty;
 * any other output, including any other warning, still fails.
 */
const SQLITE_WARNING = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/;

describe('runtime import check (C01 review finding R2)', () => {
  it('every module of every package in this repository loads with nothing refused', () => {
    const r = loadPackages(REPO_ROOT);
    assert.equal(r.stderr.replace(SQLITE_WARNING, ''), '');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^load-packages: (\d+) of \1 modules loaded\n$/);
  });

  it('refuses the red-team loads: getBuiltinModule, new Function, computed imports of node:module, hoisted and undeclared packages', () => {
    const root = tree({
      'package.json': '{"type":"module"}',
      'packages/signer/package.json': manifest('@bot/signer'),
      'packages/signer/src/a.ts': "const { createRequire } = process.getBuiltinModule('node:module');\nexport const fc = createRequire(import.meta.url)('fast-check');\n",
      'packages/signer/src/b.ts': "const name = ['fast', 'check'].join('-');\nexport const fc: unknown = await import(name);\n",
      'packages/engine/package.json': manifest('@bot/engine'),
      'packages/engine/src/c.ts': "export const f = new Function('s', 'return s');\n",
      'packages/engine/src/d.ts': "const p = ['..', '..', 'venue', 'src', 'ok.ts'].join('/');\nexport const v: unknown = await import(p);\n",
      'packages/venue/package.json': manifest('@bot/venue'),
      'packages/venue/src/e.ts': "const m = ['node', 'module'].join(':');\nexport const mod: unknown = await import(m);\n",
      'packages/venue/src/ok.ts': "import { join } from 'node:path';\nimport './sub/x.ts';\nexport const j = join('a', 'b');\n",
      'packages/venue/src/sub/x.ts': 'export const x = 1;\n',
      'packages/research/package.json': manifest('@bot/research', { 'fast-check': '4.10.2' }),
      'packages/research/src/f.ts': "const n = ['fast', 'check'].join('-');\nexport const fc: unknown = await import(n);\n",
      'packages/research/src/g.ts': "const n = ['type', 'script'].join('');\nexport const ts: unknown = await import(n);\n",
    });
    const r = loadPackages(root);
    assert.equal(r.status, 1);
    assert.deepEqual(r.stderr.trim().split('\n').sort(), [
      'load-hooks: packages/engine/src/c.ts: EvalError: Code generation from strings disallowed for this context',
      'load-hooks: packages/engine/src/d.ts: "../../venue/src/ok.ts" (path outside the package)',
      'load-hooks: packages/research/src/g.ts: "typescript" (undeclared package)',
      'load-hooks: packages/signer/src/b.ts: "fast-check" (third-party package in a zero-dependency package)',
      'load-hooks: packages/venue/src/e.ts: "node:module" (built-in not allowed)',
      'load-hooks: process.getBuiltinModule("node:module")',
    ]);
    assert.match(r.stdout, /^load-packages: 3 of 9 modules loaded\n$/, 'research f.ts (declared), venue ok.ts and sub/x.ts load');
  });

  it('refuses a symbolic link whose real path leaves the package, imported by package code or by the entry (C01 red-team A1)', () => {
    const root = tree({
      'package.json': '{"type":"module"}',
      'packages/signer/package.json': manifest('@bot/signer'),
      'packages/signer/src/fc.ts': 'export const decoy = 1;\n',               // what './fc.ts' means beside the link
      'packages/signer/src/index.ts': "import * as hop from './hop.ts';\n\nexport const loaded: number = Object.keys(hop).length;\n",
      'packages/signer/src/inside.ts': 'export const inside = 1;\n',
      'lib/hop.ts': "export * from './fc.ts';\n",                             // resolved beside the target: lib/fc.ts
      'lib/fc.ts': "export * from 'fast-check';\n",
    });
    symlinkSync('../../../lib/hop.ts', join(root, 'packages/signer/src/hop.ts'));
    symlinkSync('./inside.ts', join(root, 'packages/signer/src/same.ts'));   // a link that stays inside the package loads
    const r = loadPackages(root);
    assert.equal(r.status, 1);
    assert.deepEqual(r.stderr.trim().split('\n').sort(), [
      'load-hooks: packages/signer/src/hop.ts (real path lib/hop.ts is outside the package)',
      'load-hooks: packages/signer/src/index.ts: "./hop.ts" (real path lib/hop.ts is outside the package)',
    ]);
    assert.match(r.stdout, /^load-packages: 3 of 5 modules loaded\n$/, 'fc.ts, inside.ts and same.ts load');
  });

  it('the entry check holds when the repository is reached through a linked path (C01 red-team round 5, A6)', () => {
    const root = tree({
      'package.json': '{"type":"module"}',
      'packages/signer/package.json': manifest('@bot/signer'),
      'packages/signer/src/index.ts': 'export const x = 1;\n',
      'lib/hop.ts': "export * from 'fast-check';\n",
    });
    symlinkSync('../../../lib/hop.ts', join(root, 'packages/signer/src/hop.ts'));
    const linked = `${root}-link`;
    symlinkSync(root, linked);
    try {
      for (const r of [loadPackages(root), loadPackages(linked)]) {
        assert.equal(r.status, 1);
        assert.equal(r.stderr, 'load-hooks: packages/signer/src/hop.ts (real path lib/hop.ts is outside the package)\n');
        assert.match(r.stdout, /^load-packages: 1 of 2 modules loaded\n$/);
      }
    } finally { rmSync(linked); }
  });

  it('resolves a relative specifier as a URL, as Node does: %2e%2e and backslashes leave the package (C01 red-team round 5, A4)', () => {
    const root = tree({
      'package.json': '{"type":"module"}',
      'packages/signer/package.json': manifest('@bot/signer'),
      'packages/signer/src/%2e%2e/%2e%2e/%2e%2e/lib/fc.ts': 'export const decoy = 1;\n',   // what tsc and a path reading see
      'packages/signer/src/a.ts': "export * from './%2e%2e/%2e%2e/%2e%2e/lib/fc.ts';\n",
      'packages/signer/src/b.ts': "export * from './..\\\\..\\\\..\\\\lib/fc.ts';\n",
      'packages/signer/src/c.ts': "export * from './a%2fb.ts';\n",
      'packages/signer/src/d.ts': "export * from './%2e%2e/src/e.ts';\n",          // stays inside: allowed
      'packages/signer/src/e.ts': 'export const e = 1;\n',
      'lib/fc.ts': "export * from 'fast-check';\n",
    });
    const r = loadPackages(root);
    assert.equal(r.status, 1);
    assert.deepEqual(r.stderr.trim().split('\n').sort(), [
      'load-hooks: packages/signer/src/a.ts: "./%2e%2e/%2e%2e/%2e%2e/lib/fc.ts" (path outside the package)',
      'load-hooks: packages/signer/src/b.ts: "./..\\..\\..\\lib/fc.ts" (path outside the package)',
      'load-hooks: packages/signer/src/c.ts: "./a%2fb.ts" (not a file path)',
    ]);
    assert.match(r.stdout, /^load-packages: 3 of 6 modules loaded\n$/, 'the decoy, d.ts and e.ts load');
  });

  it('refuses other specifiers the policy refuses', () => {
    const root = tree({
      'package.json': '{"type":"module"}',
      'packages/engine/package.json': manifest('@bot/engine'),
      'packages/engine/src/a.ts': "const s = ['f', 's'].join('');\nexport const m: unknown = await import(s);\n",
      'packages/engine/src/b.ts': "const s = ['node', 'nope'].join(':');\nexport const m: unknown = await import(s);\n",
      'packages/engine/src/c.ts': "const s = ['.', 'node_modules', 'x.ts'].join('/');\nexport const m: unknown = await import(s);\n",
    });
    const r = loadPackages(root);
    assert.equal(r.status, 1);
    assert.deepEqual(r.stderr.trim().split('\n').sort(), [
      'load-hooks: packages/engine/src/a.ts: "fs" (not a checked specifier)',
      'load-hooks: packages/engine/src/b.ts: "node:nope" (built-in not allowed)',
      'load-hooks: packages/engine/src/c.ts: "./node_modules/x.ts" (path outside the package)',
    ]);
  });
});
