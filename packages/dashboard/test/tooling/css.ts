// Stylesheet bundler for the dashboard build (UI-T01). Inlines `@import "./x.css";` rules depth first (each
// file once; a cycle is an error), and rewrites every `url(...)` to a content-hashed asset next to the stylesheet:
// `./x` and `../x` resolve against the file that names them, `~pkg/path` against the package in node_modules. `data:`
// URLs are refused because the CSP (`font-src 'self'`) blocks them for fonts. Plain CSS only: no CSS Modules, because
// the repository allows only .ts modules under packages/ and loads every src module in Node.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

export interface CssAsset { source: string; fileName: string }
export interface CssBundle { css: string; assets: CssAsset[] }

/** The first 10 hex digits of the content's sha256. */
export function contentHash(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 10);
}

/** `name-<hash>.ext` for a file's content. */
export function hashedName(path: string, data: string | Uint8Array): string {
  const ext = extname(path);
  return `${basename(path, ext)}-${contentHash(data)}${ext}`;
}

/** The directory of package `name`, found the way Node looks up node_modules from `fromDir` upwards. */
export function packageDir(name: string, fromDir: string): string {
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`css: package ${name} not found from ${fromDir}`);
  }
}

/** The file a url() or @import reference names, from the stylesheet at `from`. */
export function resolveReference(ref: string, from: string): string {
  if (ref.startsWith('./') || ref.startsWith('../')) return resolve(dirname(from), ref);
  if (ref.startsWith('~')) {
    const spec = ref.slice(1);
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] as string;
    return join(packageDir(name, dirname(from)), spec.slice(name.length + 1));
  }
  throw new Error(`css: ${from}: "${ref}" must be a relative path (./, ../) or a package path (~name/file)`);
}

const IMPORT = /@import\s+["']([^"']+)["']\s*;/g;
const IMPORT_URL = /@import\s+url\(/;
const URL_REF = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

/** Bundles the stylesheet at `entry`. */
export function bundleCss(entry: string): CssBundle {
  const assets = new Map<string, string>();
  const done = new Set<string>();
  const visit = (file: string, stack: string[]): string => {
    if (stack.includes(file)) throw new Error(`css: @import cycle: ${[...stack, file].join(' -> ')}`);
    if (done.has(file)) return '';
    done.add(file);
    const raw = readFileSync(file, 'utf8');
    if (IMPORT_URL.test(raw)) throw new Error(`css: ${file}: write @import "./x.css"; (the url() form is not supported)`);
    const text = raw.replace(URL_REF, (_all, _q: string, ref: string) => {
      if (ref.startsWith('data:')) throw new Error(`css: ${file}: data: URLs are not allowed (CSP)`);
      const source = resolveReference(ref, file);
      let fileName = assets.get(source);
      if (fileName === undefined) {
        fileName = hashedName(source, readFileSync(source));
        assets.set(source, fileName);
      }
      return `url("./${fileName}")`;
    });
    return text.replace(IMPORT, (_all, ref: string) => visit(resolveReference(ref, file), [...stack, file]));
  };
  const css = visit(resolve(entry), []);
  return { css, assets: [...assets].map(([source, fileName]) => ({ source, fileName })) };
}
