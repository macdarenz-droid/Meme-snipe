// Import guard for label isolation. From every source file outside the ledger and the stats stage,
// follows imports transitively (static, side-effect, dynamic, require, export-from, package subpaths)
// and reports any path that reaches the scoring store, a ledger internal, or node:sqlite.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SPEC = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])([^'"]+)\1/g;
const DYNAMIC = /\bimport\s*\(\s*(?!['"])/g;
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

const sources = (root: string): string[] => {
  const out: string[] = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base)) {
      const src = join(base, pkg, 'src');
      if (!existsSync(src)) continue;
      for (const f of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
        const full = join(src, f);
        if (SOURCE.test(f) && !f.includes('node_modules') && statSync(full).isFile()) out.push(full);
      }
    }
  }
  return out;
};

const asFile = (p: string): string | null => {
  for (const c of [p, `${p}.ts`, `${p}.tsx`, join(p, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
};

export const importViolations = (root: string): string[] => {
  const core = join(root, 'packages/core/src');
  const ledgerEntry = join(core, 'ledger/index.ts');
  const allowed = [join(core, 'ledger') + '/', join(core, 'stats') + '/'];
  const forbidden = (file: string) => file.startsWith(join(core, 'ledger') + '/') && file !== ledgerEntry;
  const resolveSpec = (from: string, spec: string): string | null => {
    if (spec.startsWith('.')) return asFile(resolve(dirname(from), spec));
    if (spec === '@meme-snipe/core') return asFile(join(core, 'index.ts'));
    if (spec.startsWith('@meme-snipe/core/')) return asFile(join(core, spec.slice('@meme-snipe/core/'.length), 'index.ts'));
    return null; // other packages: node builtins and dependencies
  };
  const violations: string[] = [];
  for (const start of sources(root)) {
    if (allowed.some((a) => start.startsWith(a))) continue;
    const seen = new Set<string>();
    const stack: { file: string; via: string[] }[] = [{ file: start, via: [] }];
    while (stack.length > 0) {
      const { file, via } = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const chain = [...via, relative(root, file)].join(' -> ');
      if (forbidden(file)) { violations.push(`${chain} (outcome store or ledger internal)`); continue; }
      if (file === ledgerEntry) continue; // the engine-facing entry is checked by its own tests
      const text = readFileSync(file, 'utf8');
      if (DYNAMIC.test(text)) violations.push(`${chain} (dynamic import with a computed path)`);
      DYNAMIC.lastIndex = 0;
      for (const m of text.matchAll(SPEC)) {
        const spec = m[2]!;
        if (spec === 'node:sqlite' || spec === 'sqlite') { violations.push(`${chain} (imports node:sqlite)`); continue; }
        if (/ledger\/scoring/.test(spec)) { violations.push(`${chain} (imports ${spec})`); continue; }
        const target = resolveSpec(file, spec);
        if (target !== null) stack.push({ file: target, via: [...via, relative(root, file)] });
      }
    }
  }
  return violations;
};
