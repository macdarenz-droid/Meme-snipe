// Development and preview server for the dashboard (UI-T01, D-UI-09). It listens on 127.0.0.1 only, never on another
// interface, and answers on one origin: `/api/` from the fixture mock (mock-api.ts), everything else from the built
// files, with the production security headers (CSP from docs/UI.md "Dashboard authentication and network exposure"),
// so a CSP violation shows up during development, not after release.
//   node test/tooling/serve.ts --dev [--catalogue] [--port N]   builds into .dev-build/, rebuilds when src/ changes
//   node test/tooling/serve.ts --preview [--dir D] [--port N]   serves a finished build (default dist/)
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock } from '@bot/types';
import { wallClock } from '../../src/lib/clock.ts';
import { APP_PAGE, CATALOGUE_PAGE, PACKAGE_DIR, build, type Page } from './build.ts';
import { createMockApi } from './mock-api.ts';
import { requireSupportedNode } from './node-version.ts';

/** The only address the server binds (D-UI-09: never 0.0.0.0 or a public interface). */
export const HOST = '127.0.0.1';

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
  + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png',
};

export interface ServeOptions {
  mode: 'dev' | 'preview';
  /** Preview: the build to serve. Dev: where to build. */
  dir: string;
  port: number;
  pages: readonly Page[];
  clock?: Clock;
  heartbeatMs?: number;
}

export interface Running { server: Server; url: string; close(): Promise<void> }

/** The file a request path maps to inside `root`, or null when it would leave it. Paths without an extension get the page. */
export function staticFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const path = normalize(join(root, decoded));
  if (path !== root && !path.startsWith(root + sep)) return null;
  if (existsSync(path) && statSync(path).isFile()) return path;
  if (extname(decoded) !== '') return null;
  const page = decoded.replace(/^\/+/, '').split('/')[0] ?? '';
  const named = join(root, `${page}.html`);
  return page !== '' && /^[a-z-]+$/.test(page) && existsSync(named) ? named : join(root, 'index.html');
}

function sendFile(res: ServerResponse, file: string | null): void {
  if (file === null || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(readFileSync(file));
}

/** Starts the server; resolves once it listens. */
export async function serve(options: ServeOptions): Promise<Running> {
  const root = resolve(options.dir);
  let watcher: FSWatcher | null = null;
  if (options.mode === 'dev') {
    const rebuild = (): Promise<string[]> => build({ outDir: root, pages: options.pages, mode: 'development' });
    await rebuild();
    let timer: ReturnType<typeof setTimeout> | undefined;
    watcher = watch(join(PACKAGE_DIR, 'src'), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { rebuild().catch((e: unknown) => process.stderr.write(`dashboard dev: build failed: ${String(e)}\n`)); }, 100);
    });
  }
  const api = createMockApi({ fixturesDir: join(PACKAGE_DIR, 'test/fixtures'), clock: options.clock ?? wallClock, heartbeatMs: options.heartbeatMs ?? 2000, retryMs: 3000 });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const pathname = pathnameOf(req.url);
    if (pathname === null) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }
    if (pathname.startsWith('/api/')) return api(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    sendFile(res, staticFile(root, pathname));
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port, HOST, () => done());
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${HOST}:${port}/`,
    close: () => new Promise<void>((done) => {
      watcher?.close();
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}

/** The path of a request target, or null when it does not parse as a URL (a raw `GET // HTTP/1.1`). */
export function pathnameOf(target: string | undefined): string | null {
  try {
    return new URL(target ?? '/', `http://${HOST}`).pathname;
  } catch {
    return null;
  }
}

/** Parses the command-line flags. */
export function serveOptionsFor(args: readonly string[], catalogue: readonly Page[]): ServeOptions {
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dev = args.includes('--dev');
  const port = Number(value('--port') ?? (dev ? '5173' : '4173'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`serve: --port must be 0-65535, got ${String(value('--port'))}`);
  const dir = value('--dir');
  return {
    mode: dev ? 'dev' : 'preview',
    dir: resolve(PACKAGE_DIR, dir ?? (dev ? '.dev-build' : 'dist')),
    port,
    pages: dev && args.includes('--catalogue') ? [APP_PAGE, ...catalogue] : [APP_PAGE],
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireSupportedNode(process.versions.node, (code) => process.exit(code), (s) => process.stderr.write(s));
  const running = await serve(serveOptionsFor(process.argv.slice(2), [CATALOGUE_PAGE]));
  process.stdout.write(`dashboard: ${running.url} (127.0.0.1 only; API from test/fixtures)\n`);
}
