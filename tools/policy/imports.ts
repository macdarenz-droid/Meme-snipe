// Import-graph check (B-M30-01 logic 4 and 6; ARCH 12.3). A package can import a dependency it never declared (npm
// hoists every package to the root; pnpm links the root's own dependencies where every workspace file can reach
// them), and the manifest and lockfile checks would not see it. This check reads every module reference in the repository's source files: static imports, `export …
// from`, `import()`, `require()`, `import x = require()` and `typeof import()` types. Each must be one of:
// - a Node built-in with the `node:` prefix (workspace packages may not import node:module, whose createRequire and
//   loader hooks make imports the check cannot follow);
// - a relative path that stays inside its own package (or, outside packages/, inside the repository) and never
//   enters a node_modules directory;
// - a package declared in the importing package's manifest: production fields for production code, plus its own and
//   the root devDependencies for files under test/. Outside packages/, the root manifest declares what may be used;
//   under tools/ (a workspace project only for its TypeScript peer, config.ts TOOLS_DIR) tools/package.json and the
//   root manifest do, and the files are otherwise checked as root-level code, as C01 checked tools/.
// Zeroed's own files (the manifest of config.ts ZEROED_FILES_MANIFEST) and the Zeroed-only package folders (config.ts
// ZEROED_PACKAGE_PREFIXES) skip the structure rules unless the run includes them; the safety rules (config.ts
// SAFETY_IMPORT_CODES) still read every new file and the added lines of every old one (supervisor ruling 3.1).
// `@bot/types` and `@bot/signer` production code may import only node: built-ins and @bot/* packages (their
// closures are checked by E_THIRD_PARTY_RUNTIME), and `@solana/web3.js` is refused in the engine and signer whatever
// the manifest says. A specifier that is not a string literal is refused. Under packages/ and tools/, every source
// file must be .ts, so `tsc` and ESLint see all of it (E_SOURCE_TYPE). tsc and ESLint read a relative specifier as a
// path, but Node resolves it as a URL (nodejs.org esm.html ESM_RESOLVE), where `%2e%2e`, `.%2e` and `%2e.` mean `..`,
// other percent escapes are decoded, a backslash means `/`, tabs and newlines are dropped, and `?` or `#` ends the path
// (WHATWG URL Standard). The check resolves it both ways and refuses it unless both name the same file (C01 red-team
// round 5, A4). That file is the one Node loads only because the repository holds no symbolic links (symlinks.ts,
// E_SYMLINK: runChecks stops before this check when it finds one).
//
// Workspace packages also may not reach code the check cannot follow (C01 review finding R2, E_CODE_LOADING): any
// reference to getBuiltinModule (process.getBuiltinModule('node:module') bypasses the node:module ban), dlopen,
// eval, the Function constructor or a `.constructor` read (which reaches it from any function), a bare `require`, or
// a timer called with a string. Type positions are skipped: nothing in a type runs. A syntactic check cannot follow a
// property name built at run time (`process[name]`), aliasing (`const p = process`), or code loaded through
// worker_threads, child_process or vm; tools/policy/test/load-packages.test.ts loads every package module under a
// resolve hook (load-hooks.ts) to catch such loads at module load time, and review catches the rest.
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { extname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@typescript-eslint/parser';
import { DATA_DIRS, FORBIDDEN_IN_PACKAGES, INTERNAL_SCOPE, NO_THIRD_PARTY, SAFETY_IMPORT_CODES, SCHEMA_TX_FILE, SCHEMA_TX_IMPORTERS, SCHEMA_TX_TEST_DIR, SQLITE, SRC_DIR_RE, SQLITE_ALLOWED_DIRS, TEST_DIR_RE, TOOLS_DIR, WEB3, WEB3_BANNED_IN } from './config.ts';
import { finding, type Finding } from './finding.ts';
import { DEPENDENCY_FIELDS, PRODUCTION_FIELDS, type Manifest, type PackageJson, type RepoSnapshot } from './repo.ts';
import { safetyLinesOf, structureScopeOf, type SafetyLines, type Scope } from './scope.ts';

/** JavaScript and TypeScript module extensions Node or a bundler would load. */
export const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
/** Other module formats Node loads (native addons, WebAssembly). */
export const BINARY_MODULE_EXTENSIONS = ['.node', '.wasm'];
/** Directories whose modules must all be .ts. */
export const TS_ONLY_DIRS = ['packages/', 'tools/'];

/**
 * A module reference; `loader` marks a way to reach code the check cannot follow (refused in workspace packages), with
 * `kind` naming it as a key of CODE_LOADERS.
 */
export interface ModuleRef { specifier: string | null; line: number; kind: string; loader?: true }

/** Ways to reach code the import check cannot follow, with the reason each is refused (C01 review finding R2). */
export const CODE_LOADERS: Readonly<Record<string, string>> = {
  getBuiltinModule: 'process.getBuiltinModule reaches node:module (createRequire) and every other built-in',
  dlopen: 'process.dlopen loads a native addon from any path',
  eval: 'eval runs code built from a string',
  Function: 'the Function constructor runs code built from a string',
  constructor: 'a .constructor read reaches the Function constructor from any function',
  require: 'only require("literal") calls can be checked; a bare require can load anything',
  'implied eval': 'a timer called with a string runs that string as code',
};
/** Names refused wherever they appear as a value: identifiers and string literals. */
const LOADER_NAMES = new Set(['getBuiltinModule', 'dlopen', 'eval', 'Function']);
const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'execScript']);
/** Child keys whose subtree is a type, and declarations that are types: nothing in them runs. */
const TYPE_KEYS = new Set(['typeAnnotation', 'typeArguments', 'typeParameters', 'returnType', 'superTypeArguments', 'implements']);
const TYPE_NODES = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction']);

interface Node { type: string; loc?: { start: { line: number } }; [key: string]: unknown }

const SKIPPED_KEYS = new Set(['parent', 'loc', 'range', 'tokens', 'comments']);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

/** The string a specifier node spells exactly ('x', `x`, 'x' as string), or null when it is computed. */
export function literalSpecifier(n: unknown): string | null {
  if (!isNode(n)) return null;
  if (WRAPPERS.has(n.type)) return literalSpecifier(n['expression']);
  if (n.type === 'Literal') return typeof n['value'] === 'string' ? n['value'] : null;
  if (n.type !== 'TemplateLiteral') return null;
  const quasis = n['quasis'] as Array<{ value: { cooked: string | null } }>;
  return (n['expressions'] as unknown[]).length === 0 ? (quasis[0] as { value: { cooked: string | null } }).value.cooked : null;
}

/** The module a node loads: [kind, specifier node], or null when the node loads none. */
function moduleOf(n: Node): [string, unknown] | null {
  switch (n.type) {
    case 'ImportDeclaration': return ['import', n['source']];
    case 'ExportAllDeclaration': return ['export from', n['source']];
    case 'ExportNamedDeclaration': return n['source'] ? ['export from', n['source']] : null;
    case 'ImportExpression': return ['import()', n['source']];
    case 'TSImportType': return ['import type', n['source']];
    case 'TSImportEqualsDeclaration': {
      const ref = n['moduleReference'] as Node;
      return ref.type === 'TSExternalModuleReference' ? ['import = require()', ref['expression']] : null;
    }
    case 'CallExpression': {
      const callee = n['callee'] as Node;
      const name = callee.type === 'Identifier' ? callee['name'] : callee.type === 'MemberExpression' ? propertyName(callee) : null;
      return name === 'require' ? ['require()', (n['arguments'] as unknown[])[0]] : null;
    }
    default: return null;
  }
}

/** The name of a non-computed property or a computed string-literal property, or null. */
function propertyName(member: Node): string | null {
  const p = member['property'] as Node;
  return member['computed'] ? literalSpecifier(p) : (p['name'] as string);
}

interface Context { parent: Node | null; key: string; grand: Node | null; grandKey: string }

/** The way `n` reaches code the import check cannot follow (a CODE_LOADERS key), or null. */
function loaderOf(n: Node, c: Context): string | null {
  const { parent, key } = c;
  if (n.type === 'Identifier') {
    const name = n['name'] as string;
    if (LOADER_NAMES.has(name)) return name;
    if (name === 'constructor') {
      const read = (parent?.type === 'MemberExpression' && key === 'property' && parent['computed'] !== true)
        || (parent?.type === 'Property' && key === 'key' && c.grand?.type === 'ObjectPattern');
      return read ? 'constructor' : null;
    }
    if (name !== 'require') return null;
    const called = (parent?.type === 'CallExpression' && key === 'callee')
      || (parent?.type === 'MemberExpression' && key === 'property' && c.grand?.type === 'CallExpression' && c.grandKey === 'callee');
    return called ? null : 'require';
  }
  if (n.type === 'Literal' || n.type === 'TemplateLiteral') {
    const value = key === 'source' ? null : literalSpecifier(n);
    return value !== null && (LOADER_NAMES.has(value) || value === 'constructor') ? value : null;
  }
  if (n.type === 'CallExpression') {
    const callee = n['callee'] as Node;
    const name = callee.type === 'Identifier' ? callee['name'] as string : callee.type === 'MemberExpression' ? propertyName(callee) : null;
    const first = (n['arguments'] as Node[])[0];
    const text = first !== undefined && ((first.type === 'Literal' && typeof first['value'] === 'string') || first.type === 'TemplateLiteral'
      || (first.type === 'BinaryExpression' && first['operator'] === '+'));
    return name !== null && TIMERS.has(name) && text ? 'implied eval' : null;
  }
  return null;
}

/** Every module reference and code loader in `code`, in source order. Throws when the code does not parse. */
export function moduleRefs(code: string, file: string): ModuleRef[] {
  const program = parse(code, { filePath: file, sourceType: 'module', ecmaVersion: 'latest', loc: true, range: false }) as unknown as Node;
  const refs: ModuleRef[] = [];
  const lineOf = (n: Node): number => (n.loc as { start: { line: number } }).start.line;
  const visit = (n: Node, c: Context, inType: boolean): void => {
    const m = moduleOf(n);
    if (m) refs.push({ kind: m[0], specifier: literalSpecifier(m[1]), line: lineOf(n) });
    const typeNode = inType || TYPE_NODES.has(n.type);
    const loader = typeNode ? null : loaderOf(n, c);
    if (loader !== null && !refs.some((r) => r.loader && r.kind === loader && r.line === lineOf(n))) {
      refs.push({ kind: loader, specifier: null, line: lineOf(n), loader: true });
    }
    for (const [key, child] of Object.entries(n)) {
      if (SKIPPED_KEYS.has(key)) continue;
      for (const ch of Array.isArray(child) ? child : [child]) {
        if (isNode(ch)) visit(ch, { parent: n, key, grand: c.parent, grandKey: c.key }, typeNode || TYPE_KEYS.has(key));
      }
    }
  };
  visit(program, { parent: null, key: '', grand: null, grandKey: '' }, false);
  return refs;
}

/** The package a bare specifier names: "@s/p/x" → "@s/p", "p/x" → "p". */
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

const fieldsOf = (json: PackageJson, fields: readonly string[]): string[] =>
  fields.flatMap((f) => Object.keys((json as Record<string, Record<string, string> | undefined>)[f] ?? {}));

/** The manifest that governs a file; `rootLike` marks tools/, checked as root-level code against its own manifest too. */
interface ImportScope { manifest: Manifest; root: Manifest | undefined; test: boolean; rootLike?: boolean }

/**
 * The path, from the repository root and starting with `/`, of the file Node loads for the relative specifier `s` in
 * `file`: the URL resolution of `s` against the module's file URL, as ESM_RESOLVE does it. Null when that URL names no
 * file path (an encoded `/`). Posix rules on every platform, like the paths git lists.
 */
export function urlTarget(s: string, file: string): string | null {
  try {
    return fileURLToPath(new URL(s, pathToFileURL(`/${file}`, { windows: false })), { windows: false });
  } catch {
    return null;
  }
}

const trimSlash = (p: string): string => p.replace(/\/+$/, '');

const MODULE_EXT = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

/**
 * The rules on what a file may import by the imported file's repository path (Z02 rulings 29–32), whatever package
 * or directory the importing file is in and whatever extension the specifier writes: only the listed files reach
 * M24's schema transaction, and package code never reaches test code.
 */
function namedRuleFinding(file: string, target: string, where: string): Finding | null {
  if (target.replace(MODULE_EXT, '') === SCHEMA_TX_FILE.replace(MODULE_EXT, '') && !SCHEMA_TX_IMPORTERS.includes(file) && !file.startsWith(SCHEMA_TX_TEST_DIR)) {
    return finding('E_SCHEMA_TX_IMPORT', where, `${SCHEMA_TX_FILE} is the migration runner's (Z02 ruling 29); only ${SCHEMA_TX_IMPORTERS.join(' and ')} may import it`);
  }
  if (SRC_DIR_RE.test(file) && !TEST_DIR_RE.test(file) && TEST_DIR_RE.test(target)) {
    return finding('E_SRC_IMPORTS_TEST', where, `${target} is test code, reached from package code (Z02 rulings 30–32); move what both need into src`);
  }
  return null;
}

/** The finding for one module reference, or null when it is allowed. */
export function checkRef(ref: ModuleRef, file: string, scope: ImportScope): Finding | null {
  const where = `${file}:${ref.line}`;
  const s = ref.specifier;
  const { manifest, test } = scope;
  const workspace = manifest.dir !== '' && scope.rootLike !== true;
  if (ref.loader) {
    return workspace ? finding('E_CODE_LOADING', where, `${ref.kind}: ${String(CODE_LOADERS[ref.kind])}; not allowed in workspace packages, where every import must be checkable`) : null;
  }
  if (s === null) return finding('E_IMPORT_DYNAMIC', where, `${ref.kind} with a computed specifier; use a string literal so the import check can follow it`);
  if (s.startsWith('node:')) {
    if (!isBuiltin(s)) return finding('E_IMPORT_UNKNOWN', where, `"${s}" is not a Node built-in`);
    if (workspace && FORBIDDEN_IN_PACKAGES.includes(s)) return finding('E_IMPORT_FORBIDDEN', where, `"${s}" is not allowed in workspace packages (createRequire and loader hooks bypass this check)`);
    if (workspace && s === SQLITE && !SQLITE_ALLOWED_DIRS.some((d) => file.startsWith(d))) {
      return finding('E_SQLITE_OUTSIDE_M24', where, `"${s}" is M24's (B-M24-01); only ${SQLITE_ALLOWED_DIRS.join(' and ')} may import it`);
    }
    return null;
  }
  if (s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../')) {
    const target = posix.normalize(posix.join(posix.dirname(file), s));
    const named = namedRuleFinding(file, target, where);
    if (named !== null) return named;
    const inside = workspace ? target === manifest.dir || target.startsWith(`${manifest.dir}/`) : target !== '..' && !target.startsWith('../');
    if (!inside || target.split('/').includes('node_modules')) {
      return finding('E_IMPORT_PATH', where, `"${s}" leaves ${workspace ? manifest.dir : 'the repository'} or enters node_modules; import a declared package by name`);
    }
    const loaded = urlTarget(s, file);
    const read = posix.join('/', target);
    if (loaded === null || trimSlash(loaded) !== trimSlash(read)) {
      return finding('E_IMPORT_PATH', where, `"${s}": Node resolves it as a URL to ${loaded ?? 'no file path'}, but tsc and ESLint read ${read} `
        + '(paths from the repository root); write a plain relative path (no %, \\, ?, #, tab, newline or empty segment)');
    }
    return null;
  }
  if (s.startsWith('/') || s.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) {
    return finding('E_IMPORT_PATH', where, `"${s}": absolute paths, URLs and #subpath imports are not allowed`);
  }
  if (isBuiltin(s)) return finding('E_IMPORT_BUILTIN', where, `"${s}" is a Node built-in: import "node:${s}"`);
  const name = packageName(s);
  if (name.startsWith(INTERNAL_SCOPE) && s.length > name.length) {
    // `@bot/<n>` is `packages/<n>`: a subpath names a file there, which the named rules check like a relative path.
    const named = namedRuleFinding(file, posix.normalize(`packages/${name.slice(INTERNAL_SCOPE.length)}${s.slice(name.length)}`), where);
    if (named !== null) return named;
  }
  if (workspace && WEB3_BANNED_IN.includes(manifest.json.name ?? '') && name === WEB3) {
    return finding('E_WEB3_BANNED', where, `${WEB3} is banned in ${String(manifest.json.name)} (B-M30-01)`);
  }
  if (name === manifest.json.name) return null;
  if (workspace && !test && NO_THIRD_PARTY.includes(manifest.json.name ?? '') && !name.startsWith(INTERNAL_SCOPE)) {
    return finding('E_THIRD_PARTY_RUNTIME', where, `${String(manifest.json.name)} may import only node: built-ins and ${INTERNAL_SCOPE}* packages; found ${name}`);
  }
  const allowed = scope.rootLike === true ? [...fieldsOf(manifest.json, DEPENDENCY_FIELDS), ...fieldsOf(scope.root?.json ?? {}, DEPENDENCY_FIELDS)]
    : !workspace ? fieldsOf(manifest.json, DEPENDENCY_FIELDS)
    : test ? [...fieldsOf(manifest.json, DEPENDENCY_FIELDS), ...fieldsOf(scope.root?.json ?? {}, DEPENDENCY_FIELDS)]
      : fieldsOf(manifest.json, PRODUCTION_FIELDS);
  if (allowed.includes(name)) return null;
  const fields = !workspace || test ? 'any dependency field' : 'dependencies, optionalDependencies or peerDependencies';
  return finding('E_UNDECLARED_IMPORT', where, `${name} is not declared in ${manifest.file} (${fields}${(workspace && test) || scope.rootLike === true ? ', or the root package.json' : ''})`);
}

/** Import specifiers of a module the parser cannot read, line by line (the safety checks' fallback, ruling 3.1). */
export function looseModuleRefs(text: string): ModuleRef[] {
  const refs: ModuleRef[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|^\s*export\s+\*\s+from\s*)(['"`])([^'"`\n]+)\1/g)) {
      refs.push({ specifier: m[2] as string, line: i + 1, kind: 'import' });
    }
  });
  return refs;
}

/**
 * Checks every source file of `files` (paths relative to the repository root). Supervisor ruling 3.1 splits the rules:
 * - `scope` admits a file to every rule (the structure rules: import paths, source types, code loading, …); it skips
 *   Zeroed's own files and the Zeroed-only package folders (scope.ts structureScopeOf);
 * - a file it skips still gets the safety rules (config.ts SAFETY_IMPORT_CODES) on the lines `lines` names: every
 *   line of a new file, the added lines of an old Zeroed file. A module the parser cannot read is then read line by
 *   line for its import specifiers, so an added import is never missed.
 */
export function checkImports(snapshot: RepoSnapshot, files: readonly string[], scope: Scope = structureScopeOf(false),
  lines: SafetyLines = safetyLinesOf(false, new Map())): Finding[] {
  const findings: Finding[] = [];
  const root = snapshot.manifests.find((m) => m.dir === '');
  const workspaces = snapshot.manifests.filter((m) => m.dir !== '');
  for (const file of [...files].sort()) {
    if (DATA_DIRS.some((d) => file.startsWith(d))) continue;
    const structural = scope(file);
    const safety = structural ? 'all' : lines(file);
    if (!structural && safety !== 'all' && safety.size === 0) continue;
    const ext = extname(file);
    if (structural && ext !== '.ts' && TS_ONLY_DIRS.some((d) => file.startsWith(d)) && [...SOURCE_EXTENSIONS, ...BINARY_MODULE_EXTENSIONS].includes(ext)) {
      findings.push(finding('E_SOURCE_TYPE', file, `only .ts modules are allowed under ${TS_ONLY_DIRS.join(' and ')} (type-checked and linted); found ${ext}`));
    }
    if (!SOURCE_EXTENSIONS.includes(ext)) continue;
    const manifest = workspaces.find((m) => file.startsWith(`${m.dir}/`)) ?? root;
    if (manifest === undefined) continue;                               // no root manifest: reported by readRepo
    const text = readFileSync(join(snapshot.root, file), 'utf8');
    let refs: ModuleRef[];
    try {
      refs = moduleRefs(text, file);
    } catch {
      if (structural) {
        findings.push(finding('E_IMPORT_PARSE', file, 'cannot parse the module, so its imports cannot be checked'));
        continue;
      }
      refs = looseModuleRefs(text);
    }
    const rootLike = manifest.dir === TOOLS_DIR;
    const test = manifest.dir !== '' && !rootLike && file.startsWith(`${manifest.dir}/test/`);
    for (const ref of refs) {
      const f = checkRef(ref, file, { manifest, root, test, rootLike });
      if (f === null) continue;
      if (structural || (SAFETY_IMPORT_CODES.includes(f.code) && (safety === 'all' || safety.has(ref.line)))) findings.push(f);
    }
  }
  return findings;
}
