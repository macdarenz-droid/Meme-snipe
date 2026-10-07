// Runtime import check (C01 review finding R2), preloaded with --import by load-packages.test.ts. It registers a
// module.registerHooks resolve hook (Node >= 22.15.0) that refuses any module package code asks for that the policy
// would refuse, and refuses process.getBuiltinModule while packages load. The syntactic check (tools/policy/imports.ts)
// cannot follow a property name built at run time or an alias; this catches such a load when it runs at module load
// time. The test runs the process with --disallow-code-generation-from-strings, so eval and new Function throw too.
// Allowed, by the importing file's package (packages/<name>/, outside node_modules): node: built-ins except
// node:module, relative paths inside the package (never into node_modules), @bot/* workspace links, and the package's
// declared production dependencies (none for @bot/types and @bot/signer). LOAD_HOOKS_ROOT names the repository root.
// Node loads a module from its real path (ESM_RESOLVE step 7.4), so the hook also checks where a relative import, or
// the entry's file: import of a package module, really lands: a symbolic link inside a package must not reach a file
// outside it (C01 red-team round 3, finding A1; tools/policy/symlinks.ts refuses links in the repository). A relative
// specifier is resolved as a URL against the importer's URL, as Node resolves it, so `%2e%2e` and a backslash count as
// `..` and `/` (C01 red-team round 5, A4). The entry names package files under LOAD_HOOKS_ROOT, which may be reached
// through a symbolic link: such a path is read under the root's real path (C01 red-team round 5, A6).
// Refusals are kept in globalThis[Symbol.for('load-hooks.refused')] (the entry code adds its import errors there);
// at exit they are printed, one line each, and the exit code is 1.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_IN_PACKAGES, INTERNAL_SCOPE, NO_THIRD_PARTY } from '../config.ts';
import { PRODUCTION_FIELDS, type PackageJson } from '../repo.ts';

const given = resolve(process.env['LOAD_HOOKS_ROOT'] ?? process.cwd());
const root = realpathSync(given);
const packagesDir = join(root, 'packages');
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(packagesDir, d.name, 'package.json')))
  .map((d) => ({ dir: realpathSync(join(packagesDir, d.name)), json: JSON.parse(readFileSync(join(packagesDir, d.name, 'package.json'), 'utf8')) as PackageJson }));
const refused: string[] = [];
(globalThis as Record<symbol, unknown>)[Symbol.for('load-hooks.refused')] = refused;
const rel = (p: string): string => relative(root, p).split(sep).join('/');

const isRelative = (specifier: string): boolean => specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
/** The file path of a file: URL, with a LOAD_HOOKS_ROOT reached through a link replaced by its real path. */
const located = (url: string): string => {
  const path = fileURLToPath(url);
  return path.startsWith(`${given}${sep}`) ? join(root, path.slice(given.length + 1)) : path;
};

function packageOf(url: string | undefined): (typeof packages)[number] | undefined {
  if (url === undefined || !url.startsWith('file:')) return undefined;
  const path = located(url);
  if (path.split(sep).includes('node_modules')) return undefined;
  return packages.find((p) => path.startsWith(`${p.dir}${sep}`));
}

/** Why `specifier`, asked for by the module at `parentURL` in package `pkg`, is refused; null when it is allowed. */
function refusal(specifier: string, pkg: (typeof packages)[number], parentURL: string): string | null {
  if (specifier.startsWith('node:')) return FORBIDDEN_IN_PACKAGES.includes(specifier) || !isBuiltin(specifier) ? 'built-in not allowed' : null;
  if (isRelative(specifier)) {
    let target: string;
    try {
      target = fileURLToPath(new URL(specifier, parentURL));
    } catch {
      return 'not a file path';
    }
    return target.startsWith(`${pkg.dir}${sep}`) && !target.split(sep).includes('node_modules') ? null : 'path outside the package';
  }
  if (specifier.startsWith(INTERNAL_SCOPE)) return null;
  if (specifier.startsWith('/') || specifier.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) || isBuiltin(specifier)) return 'not a checked specifier';
  if (NO_THIRD_PARTY.includes(pkg.json.name ?? '')) return 'third-party package in a zero-dependency package';
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] as string;
  return PRODUCTION_FIELDS.some((f) => Object.hasOwn(pkg.json[f] ?? {}, name)) ? null : 'undeclared package';
}

function refuse(entry: string, specifier: string): never {
  refused.push(entry);
  throw new Error(`load-hooks: refused "${specifier}"`);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const pkg = packageOf(context.parentURL);
    const parentPath = pkg === undefined ? null : fileURLToPath(context.parentURL as string);
    if (pkg !== undefined) {
      const why = refusal(specifier, pkg, context.parentURL as string);
      if (why !== null) refuse(`${rel(parentPath as string)}: "${specifier}" (${why})`, specifier);
    }
    const resolved = nextResolve(specifier, context);
    // The package a module is asked for in: the importer's for a relative import, the module's own for the entry's
    // import of a package file by URL. Its real path must stay in that package's real directory, outside node_modules.
    const owner = pkg !== undefined ? (isRelative(specifier) ? pkg : undefined) : packageOf(specifier);
    if (owner !== undefined) {
      const real = realpathSync(fileURLToPath(resolved.url));
      if (!real.startsWith(`${owner.dir}${sep}`) || real.split(sep).includes('node_modules')) {
        const from = parentPath === null ? rel(located(specifier)) : `${rel(parentPath)}: "${specifier}"`;
        refuse(`${from} (real path ${rel(real)} is outside the package)`, specifier);
      }
    }
    return resolved;
  },
});

process.getBuiltinModule = ((id: string) => {
  refused.push(`process.getBuiltinModule("${id}")`);
  throw new Error('load-hooks: process.getBuiltinModule is refused while packages load');
}) as typeof process.getBuiltinModule;

process.on('exit', () => {
  if (refused.length > 0) {
    process.stderr.write(`${refused.map((r) => `load-hooks: ${r}`).join('\n')}\n`);
    process.exitCode = 1;
  }
});
