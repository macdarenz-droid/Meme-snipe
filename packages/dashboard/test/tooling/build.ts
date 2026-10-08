// Static build of the dashboard (UI-T01, D-UI-04): Vite 8 (its build API, no config file and no plugin beyond the page
// entries below) bundles each page's module into hashed ES modules,
// css.ts bundles its stylesheet, and the page's HTML template gets the tags. The output is static files only: no
// source maps, no Node runtime; the bot API serves them on its own origin. Each page entry is a virtual module that
// imports the page's start function and calls it with `document`, so no src module has side effects on import.
//   node test/tooling/build.ts          production build of the app into dist/
//   node test/tooling/build.ts --e2e    production build of the app and the component catalogue into .e2e-build/
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild, type Rolldown } from 'vite';
import { bundleCss, contentHash, resolveReference } from './css.ts';
import { requireSupportedNode } from './node-version.ts';

export const PACKAGE_DIR = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** A page of the build: its HTML template, the module whose `start` export mounts it, and its stylesheet. */
export interface Page {
  name: string;
  template: string;
  module: string;
  exportName: string;
  stylesheet: string;
  /** Font files to preload, as the stylesheet names them (`~package/path` or a path relative to the stylesheet). */
  preloadFonts: string[];
}

/** The Latin subset of Inter, preloaded on every page (UI-T03). */
export const PRELOAD_FONTS = ['~@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2'];

export const APP_PAGE: Page = {
  name: 'index', template: 'index.html', module: 'src/main.ts', exportName: 'start', stylesheet: 'src/styles/index.css', preloadFonts: PRELOAD_FONTS,
};

/** The component catalogue (src/catalogue): built for the browser tests and served by `npm run storybook`, never shipped. */
export const CATALOGUE_PAGE: Page = {
  name: 'catalogue', template: 'catalogue.html', module: 'src/catalogue/main.ts', exportName: 'startCatalogue',
  stylesheet: 'src/styles/catalogue.css', preloadFonts: PRELOAD_FONTS,
};

export type BuildMode = 'production' | 'development';
export interface BuildOptions { outDir: string; pages: readonly Page[]; mode: BuildMode }

const PAGE_PREFIX = '\0page:';

/**
 * Build logs to drop: the `"use client"` directive that Radix and Lucide modules carry is meaningful only to React
 * server components, which this static SPA does not use; the bundler warns for every such module. Everything else is kept.
 */
export function isIgnoredLog(log: { code?: string; message: string }): boolean {
  return log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('"use client"');
}
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Every file under `dir`, as sorted paths relative to it with `/` separators. */
export function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join('/'))
    .sort();
}

/** Builds `pages` into `outDir` (emptied first). Returns the files written, relative to outDir. */
export async function build(options: BuildOptions): Promise<string[]> {
  const outDir = resolve(options.outDir);
  const assetsDir = join(outDir, 'assets');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });
  const pages = new Map(options.pages.map((p) => [p.name, p]));

  const result = await viteBuild({
    configFile: false,
    root: PACKAGE_DIR,
    envDir: false,
    publicDir: false,
    logLevel: 'warn',
    mode: options.mode,
    define: { 'process.env.NODE_ENV': JSON.stringify(options.mode) },
    plugins: [{
      name: 'dashboard-pages',
      resolveId: (id) => (id.startsWith(PAGE_PREFIX) ? id : null),
      load(id) {
        const page = id.startsWith(PAGE_PREFIX) ? pages.get(id.slice(PAGE_PREFIX.length)) : undefined;
        if (page === undefined) return null;
        const file = JSON.stringify(join(PACKAGE_DIR, page.module));
        return `import { ${page.exportName} } from ${file};\n${page.exportName}(document);\n`;
      },
    }],
    build: {
      outDir: assetsDir,
      emptyOutDir: false,
      assetsDir: '',
      copyPublicDir: false,
      write: true,
      minify: options.mode === 'production',
      sourcemap: false,
      modulePreload: false,
      reportCompressedSize: false,
      target: 'es2023',
      rolldownOptions: {
        input: Object.fromEntries(options.pages.map((p) => [p.name, `${PAGE_PREFIX}${p.name}`])),
        onLog(level, log, handler) {
          if (!isIgnoredLog(log)) handler(level, log);
        },
        output: { format: 'es', entryFileNames: '[name]-[hash].js', chunkFileNames: 'chunk-[hash].js' },
      },
    },
  });
  // `write: true` without watch resolves to the written bundle (one environment: one output).
  const { output } = (Array.isArray(result) ? result[0] : result) as Rolldown.RolldownOutput;

  for (const page of options.pages) {
    const entry = output.find((o): o is Rolldown.OutputChunk => o.type === 'chunk' && o.isEntry && o.name === page.name) as Rolldown.OutputChunk;
    const css = bundleCss(join(PACKAGE_DIR, page.stylesheet));
    for (const asset of css.assets) cpSync(asset.source, join(assetsDir, asset.fileName));
    const cssName = `${page.name}-${contentHash(css.css)}.css`;
    writeFileSync(join(assetsDir, cssName), css.css);
    const fontName = (ref: string): string => {
      const source = resolveReference(ref, join(PACKAGE_DIR, page.stylesheet));
      const asset = css.assets.find((a) => a.source === source);
      if (asset === undefined) throw new Error(`build: ${page.name}: preloaded font ${ref} is not used by ${page.stylesheet}`);
      return asset.fileName;
    };
    const head = [
      ...page.preloadFonts.map((f) => `<link rel="preload" href="/assets/${escapeAttr(fontName(f))}" as="font" type="font/woff2" crossorigin>`),
      ...entry.imports.map((c) => `<link rel="modulepreload" href="/assets/${escapeAttr(c)}">`),
      `<link rel="stylesheet" href="/assets/${escapeAttr(cssName)}">`,
    ].join('\n    ');
    const body = `<script type="module" src="/assets/${escapeAttr(entry.fileName)}"></script>`;
    const template = readFileSync(join(PACKAGE_DIR, page.template), 'utf8');
    if (!template.includes('<!-- build:head -->') || !template.includes('<!-- build:body -->')) {
      throw new Error(`build: ${page.template} needs the <!-- build:head --> and <!-- build:body --> markers`);
    }
    writeFileSync(join(outDir, `${page.name}.html`), template.replace('<!-- build:head -->', head).replace('<!-- build:body -->', body));
  }
  const licenses = join(PACKAGE_DIR, 'licenses');
  if (existsSync(licenses)) cpSync(licenses, join(outDir, 'licenses'), { recursive: true });
  return listFiles(outDir);
}

/** The pages and output directory for the command-line flags. */
export function buildOptionsFor(args: readonly string[], extraPages: readonly Page[]): BuildOptions {
  return args.includes('--e2e')
    ? { outDir: join(PACKAGE_DIR, '.e2e-build'), pages: [APP_PAGE, ...extraPages], mode: 'production' }
    : { outDir: join(PACKAGE_DIR, 'dist'), pages: [APP_PAGE], mode: 'production' };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireSupportedNode(process.versions.node, (code) => process.exit(code), (s) => process.stderr.write(s));
  const options = buildOptionsFor(process.argv.slice(2), [CATALOGUE_PAGE]);
  const files = await build(options);
  process.stdout.write(`dashboard build: ${files.length} files in ${relative(process.cwd(), options.outDir) || '.'}\n`);
}
