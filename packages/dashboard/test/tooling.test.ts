// UI-T01 tooling: the static build (acceptance 1), the 127.0.0.1-only dev server (acceptance 2), the fixture mock API,
// the stylesheet bundler and the Node version guard (edge case).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer as createTcpServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, describe, it } from 'vitest';
import type { Clock, UnixMs } from '@bot/types';
import { APP_PAGE, PACKAGE_DIR, build, buildOptionsFor, isIgnoredLog, listFiles } from './tooling/build.ts';
import { bundleCss, contentHash, hashedName, packageDir, resolveReference } from './tooling/css.ts';
import { createMockApi, nextSeq, sseFrame } from './tooling/mock-api.ts';
import { requireSupportedNode, unsupportedNode } from './tooling/node-version.ts';
import { CSP, HOST, pathnameOf, serve, serveOptionsFor, staticFile } from './tooling/serve.ts';

const tmp = mkdtempSync(join(tmpdir(), 'dashboard-tooling-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const fixedClock: Clock = { nowMs: () => Date.parse('2026-10-06T14:02:11.123Z') as UnixMs, kind: 'wall' };

/** Static file types a browser loads; anything else in dist/ would be a server artefact. */
const STATIC = /\.(html|js|css|woff2|txt|png)$/;

describe('UI-T01 acceptance 1: the build emits static files only, with no source maps', () => {
  it('builds index.html and hashed assets; nothing references a source map', async () => {
    const out = join(tmp, 'dist');
    const files = await build({ outDir: out, pages: [APP_PAGE], mode: 'production' });
    assert.deepEqual(files, listFiles(out));
    assert.ok(files.includes('index.html'));
    for (const f of files) {
      assert.match(f, STATIC, f);
      assert.doesNotMatch(f, /\.map$/);
      assert.doesNotMatch(readFileSync(join(out, f), 'latin1'), /sourceMappingURL/, f);
    }
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1] as string);
    assert.equal(refs.length, 3, 'the preloaded Inter Latin font, one stylesheet and one module script');
    for (const ref of refs) {
      assert.ok(files.includes(ref), ref);
      assert.match(ref, /-[A-Za-z0-9_-]{8,}\.(js|css|woff2)$/, 'content-hashed name');
    }
    assert.match(html, /<link rel="preload" href="\/assets\/inter-latin-opsz-normal-[0-9a-f]{10}\.woff2" as="font" type="font\/woff2" crossorigin>/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script (CSP script-src self)');
    assert.doesNotMatch(html, /<style|\sstyle=/, 'no inline style (CSP style-src self)');
    assert.ok(files.includes('licenses/inter-OFL.txt') && files.includes('licenses/jetbrains-mono-OFL.txt'), 'OFL texts ship with the fonts');
    assert.equal(files.filter((f) => f.endsWith('.woff2')).length, 4, 'Inter and JetBrains Mono, Latin and Latin Extended');
  });

  it('npm run build writes dist/ through the command line', () => {
    const r = spawnSync(process.execPath, ['test/tooling/build.ts'], { cwd: PACKAGE_DIR, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^dashboard build: \d+ files in dist\n$/);
    assert.ok(listFiles(join(PACKAGE_DIR, 'dist')).includes('index.html'));
  });

  it('drops only the "use client" directive warnings', () => {
    assert.equal(isIgnoredLog({ code: 'MODULE_LEVEL_DIRECTIVE', message: 'The semantics of the module level directive "use client" in x' }), true);
    assert.equal(isIgnoredLog({ code: 'MODULE_LEVEL_DIRECTIVE', message: 'directive "use strict"' }), false);
    assert.equal(isIgnoredLog({ code: 'UNRESOLVED_IMPORT', message: '"use client"' }), false);
    assert.equal(isIgnoredLog({ message: 'x' }), false);
  });

  it('--e2e builds the extra pages into .e2e-build', () => {
    const extra = { ...APP_PAGE, name: 'extra' };
    assert.deepEqual(buildOptionsFor(['--e2e'], [extra]), { outDir: join(PACKAGE_DIR, '.e2e-build'), pages: [APP_PAGE, extra], mode: 'production' });
    assert.deepEqual(buildOptionsFor([], [extra]), { outDir: join(PACKAGE_DIR, 'dist'), pages: [APP_PAGE], mode: 'production' });
  });

  it('refuses a template without the build markers and an unused preloaded font', async () => {
    writeFileSync(join(PACKAGE_DIR, 'test/fixtures/no-markers.html'), '<!doctype html><title>x</title>');
    try {
      await assert.rejects(build({ outDir: join(tmp, 'bad'), pages: [{ ...APP_PAGE, template: 'test/fixtures/no-markers.html' }], mode: 'production' }), /needs the <!-- build:head -->/);
    } finally { rmSync(join(PACKAGE_DIR, 'test/fixtures/no-markers.html')); }
    await assert.rejects(build({ outDir: join(tmp, 'bad2'), pages: [{ ...APP_PAGE, preloadFonts: ['./x.woff2'] }], mode: 'production' }), /preloaded font .\/x.woff2 is not used/);
  });
});

/** Resolves to true when a TCP connection to host:port opens, false when it is refused or times out. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host, port, timeout: 1000 });
    s.once('connect', () => { s.destroy(); done(true); });
    s.once('error', () => done(false));
    s.once('timeout', () => { s.destroy(); done(false); });
  });
}

describe('UI-T01 acceptance 2: the dev server loads on 127.0.0.1 and nowhere else', () => {
  it('binds 127.0.0.1 only, serves the app with the CSP and is refused on every other interface', async () => {
    const running = await serve({ mode: 'dev', dir: join(tmp, 'dev'), port: 0, pages: [APP_PAGE], clock: fixedClock });
    try {
      const address = running.server.address() as { address: string; port: number };
      assert.equal(address.address, HOST);
      const res = await fetch(running.url);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), CSP);
      assert.match(await res.text(), /<div id="root"><\/div>/);
      const others = Object.values(networkInterfaces()).flat().filter((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
      for (const i of others) assert.equal(await reachable((i as { address: string }).address, address.port), false, i?.address);
      assert.equal(await reachable('127.0.0.1', address.port), true);
    } finally { await running.close(); }
  });

  it('control: the probe does reach a server bound to every interface', async () => {
    const all = createTcpServer((s) => s.destroy());
    await new Promise<void>((done) => all.listen(0, '0.0.0.0', done));
    try {
      const { port } = all.address() as { port: number };
      const others = Object.values(networkInterfaces()).flat().filter((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
      for (const i of others) assert.equal(await reachable((i as { address: string }).address, port), true, i?.address);
    } finally { await new Promise((done) => all.close(done)); }
  });

  it('serves static files with long caching for hashed assets, refuses other methods and unknown files', async () => {
    const dir = join(tmp, 'static');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<p>i</p>');
    writeFileSync(join(dir, 'assets/a-1.js'), 'x');
    writeFileSync(join(dir, 'assets/f.bin'), 'x');
    const running = await serve({ mode: 'preview', dir, port: 0, pages: [APP_PAGE], heartbeatMs: 50 });
    try {
      const js = await fetch(`${running.url}assets/a-1.js`);
      assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal((await fetch(`${running.url}assets/f.bin`)).headers.get('content-type'), 'application/octet-stream');
      assert.equal((await fetch(`${running.url}positions`)).headers.get('cache-control'), 'no-cache');
      assert.equal((await fetch(`${running.url}assets/missing.js`)).status, 404);
      assert.equal((await fetch(running.url, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${running.url}api/v1/vm/VM-01`)).status, 200);
    } finally { await running.close(); }
  });

  it('answers 400 to a request target that is not a URL and keeps serving (review m7)', async () => {
    const running = await serve({ mode: 'preview', dir: tmp, port: 0, pages: [APP_PAGE] });
    const { port } = running.server.address() as { port: number };
    const raw = (target: string): Promise<string> => new Promise((done, fail) => {
      const socket = connect(port, HOST, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`));
      let text = '';
      socket.on('data', (d: Buffer) => { text += d.toString(); });
      socket.on('end', () => done(text));
      socket.on('error', fail);
    });
    try {
      for (const target of ['//', '//[', '//:abc']) assert.match(await raw(target), /^HTTP\/1\.1 400 /, target);
      assert.equal((await fetch(`${running.url}api/v1/vm/VM-01`)).status, 200, 'the server is still up');
    } finally { await running.close(); }
    assert.equal(pathnameOf(undefined), '/');
    assert.equal(pathnameOf('/a/b?c'), '/a/b');
    assert.equal(pathnameOf('//'), null);
  });

  it('the mock API answers 400 to a target that is not a URL (review m7)', () => {
    const api = createMockApi({ fixturesDir: join(PACKAGE_DIR, 'test/fixtures'), clock: fixedClock, heartbeatMs: 1000, retryMs: 3000 });
    const seen: Array<[number, string]> = [];
    let status = 0;
    const res = { writeHead: (s: number) => { status = s; }, end: (body: string) => { seen.push([status, body]); } } as unknown as ServerResponse;
    api({ url: '//', method: 'GET', headers: {} } as unknown as IncomingMessage, res);
    assert.deepEqual(seen, [[400, '{"error":"bad_request"}']]);
  });

  it('a port already in use rejects', async () => {
    const first = await serve({ mode: 'preview', dir: tmp, port: 0, pages: [APP_PAGE] });
    try {
      const { port } = first.server.address() as { port: number };
      await assert.rejects(serve({ mode: 'preview', dir: tmp, port, pages: [APP_PAGE] }), /EADDRINUSE/);
    } finally { await first.close(); }
  });

  it('maps request paths to files inside the root only', () => {
    const root = join(tmp, 'map');
    mkdirSync(join(root, 'assets'), { recursive: true });
    for (const f of ['index.html', 'catalogue.html', 'assets/a.js']) writeFileSync(join(root, f), '');
    assert.equal(staticFile(root, '/assets/a.js'), join(root, 'assets/a.js'));
    assert.equal(staticFile(root, '/'), join(root, 'index.html'));
    assert.equal(staticFile(root, '/positions/x'), join(root, 'index.html'));
    assert.equal(staticFile(root, '/catalogue'), join(root, 'catalogue.html'));
    assert.equal(staticFile(root, '/Catalogue'), join(root, 'index.html'));
    assert.equal(staticFile(root, '/assets/b.js'), null);
    assert.equal(staticFile(root, '/../package.json'), null);
    assert.equal(staticFile(root, '/%2e%2e/%2e%2e/etc/passwd'), null);
    assert.equal(staticFile(root, '/a%00b'), null);
    assert.equal(staticFile(root, '/%E0%A4%A'), null);
  });

  it('parses the command line: dev on 5173, preview on 4173, --port, --dir and --catalogue', () => {
    const cat = { ...APP_PAGE, name: 'catalogue' };
    assert.deepEqual(serveOptionsFor(['--dev'], [cat]), { mode: 'dev', dir: join(PACKAGE_DIR, '.dev-build'), port: 5173, pages: [APP_PAGE] });
    assert.deepEqual(serveOptionsFor(['--dev', '--catalogue', '--port', '0'], [cat]).pages, [APP_PAGE, cat]);
    assert.deepEqual(serveOptionsFor(['--preview', '--dir', '.e2e-build', '--port', '4317'], [cat]),
      { mode: 'preview', dir: join(PACKAGE_DIR, '.e2e-build'), port: 4317, pages: [APP_PAGE] });
    assert.throws(() => serveOptionsFor(['--port', 'x'], []), /--port must be 0-65535/);
    assert.throws(() => serveOptionsFor(['--port', '70000'], []), /--port must be 0-65535/);
  });
});

describe('UI-T01 mock API: fixture REST and SSE', () => {
  let running: Awaited<ReturnType<typeof serve>>;
  const start = async (): Promise<string> => {
    running = await serve({ mode: 'preview', dir: tmp, port: 0, pages: [APP_PAGE], clock: fixedClock, heartbeatMs: 30 });
    return running.url;
  };
  afterAll(async () => { await running.close(); });

  /** Reads the stream until `predicate` holds for the text so far, then aborts. */
  async function readStream(url: string, predicate: (text: string) => boolean, headers: Record<string, string> = {}): Promise<string> {
    const ac = new AbortController();
    const res = await fetch(url, { signal: ac.signal, headers });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!predicate(text)) text += decoder.decode((await reader.read()).value);
    ac.abort();
    return text;
  }

  it('serves a VM snapshot from its fixture, 404 for unknown VMs and paths, 405 for writes', async () => {
    const url = await start();
    const vm = await fetch(`${url}api/v1/vm/VM-01`);
    assert.equal(vm.status, 200);
    assert.equal(((await vm.json()) as { vm: string }).vm, 'VM-01');
    assert.deepEqual(await (await fetch(`${url}api/v1/vm/VM-99`)).json(), { error: 'not_found', vm: 'VM-99' });
    assert.equal((await fetch(`${url}api/v1/other`)).status, 404);
    assert.equal((await fetch(`${url}api/v1/vm/VM-01`, { method: 'POST' })).status, 405);
  });

  it('streams retry, then heartbeats with id and seq from 1, every heartbeatMs', async () => {
    const text = await readStream(`${running.url}api/v1/stream`, (t) => t.includes('id: 2\n'));
    assert.match(text, /^retry: 3000\n\nid: 1\nevent: heartbeat\ndata: /);
    const first = JSON.parse((/^data: (.*)$/m.exec(text) as RegExpExecArray)[1] as string) as Record<string, unknown>;
    assert.equal(first['seq'], '1');
    assert.equal(first['server_time'], '2026-10-06T14:02:11.123Z');
    assert.equal(first['emitted_at'], '2026-10-06T14:02:11.123Z');
  });

  it('continues after Last-Event-ID and plays a fixture script', async () => {
    const text = await readStream(`${running.url}api/v1/stream?script=demo`, (t) => t.includes('event: replace'), { 'last-event-id': '41' });
    assert.match(text, /id: 42\nevent: heartbeat/);
    assert.match(text, /id: 43\nevent: replace\ndata: \{"vm":"VM-03"/);
  });

  it('refuses unknown or malformed script names', async () => {
    assert.equal((await fetch(`${running.url}api/v1/stream?script=nope`)).status, 404);
    assert.equal((await fetch(`${running.url}api/v1/stream?script=..%2Fvm%2FVM-01`)).status, 404);
  });

  it('nextSeq and sseFrame', () => {
    assert.equal(nextSeq(undefined), 1n);
    assert.equal(nextSeq('x'), 1n);
    assert.equal(nextSeq('18446744073709551615'), 18446744073709551616n);
    assert.equal(sseFrame(7n, { kind: 'upsert', a: 1 }), 'id: 7\nevent: upsert\ndata: {"kind":"upsert","a":1,"seq":"7"}\n\n');
  });
});

describe('UI-T01 stylesheet bundler', () => {
  const dir = join(tmp, 'css');
  const write = (f: string, s: string): string => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), s); return join(dir, f); };

  it('inlines relative imports once, in order, and hashes url() assets from paths and packages', () => {
    write('fonts/a.woff2', 'AAA');
    write('node_modules/@x/font/package.json', '{}');
    write('node_modules/@x/font/files/b.woff2', 'BBB');
    write('node_modules/plain/package.json', '{}');
    write('node_modules/plain/c.woff2', 'CCC');
    write('styles/c.css', '.c{}\n');
    write('styles/b.css', '@import "./c.css";\n.b{background:url(../fonts/a.woff2)}\n');
    const entry = write('styles/a.css', "@import './b.css';\n@import \"./c.css\";\n.a{src:url('~@x/font/files/b.woff2'),url(\"~plain/c.woff2\"),url(../fonts/a.woff2)}\n");
    const out = bundleCss(entry);
    const a = hashedName('a.woff2', 'AAA');
    assert.equal(out.css, `.c{}\n\n.b{background:url("./${a}")}\n\n\n.a{src:url("./${hashedName('b.woff2', 'BBB')}"),url("./${hashedName('c.woff2', 'CCC')}"),url("./${a}")}\n`);
    assert.deepEqual(out.assets.map((x) => x.fileName).sort(), [a, hashedName('b.woff2', 'BBB'), hashedName('c.woff2', 'CCC')].sort());
  });

  it('refuses cycles, other import forms, data: URLs, bare references and missing packages', () => {
    write('cyc/a.css', '@import "./b.css";');
    write('cyc/b.css', '@import "./a.css";');
    assert.throws(() => bundleCss(join(dir, 'cyc/a.css')), /@import cycle/);
    assert.throws(() => bundleCss(write('u.css', '@import url("./x.css");')), /url\(\) form is not supported/);
    assert.throws(() => bundleCss(write('d.css', '.x{background:url(data:image/png;base64,AA)}')), /data: URLs are not allowed/);
    assert.throws(() => bundleCss(write('e.css', '.x{background:url(https://cdn.example/x.png)}')), /must be a relative path/);
    assert.throws(() => resolveReference('~missing-pkg/x', join(tmpdir(), 'x.css')), /package missing-pkg not found/);
    assert.equal(packageDir('@x/font', join(dir, 'styles')), join(dir, 'node_modules/@x/font'));
    assert.equal(contentHash('a'), 'ca978112ca');
  });
});

describe('UI-T01 edge case: Node below the bundler engines', () => {
  it('names the required range for an old Node and accepts supported ones', () => {
    for (const v of ['20.18.3', '22.11.0', '18.20.0', 'garbage']) assert.match(unsupportedNode(v) ?? '', /needs Node \^20\.19\.0 \|\| >=22\.12\.0/, v);
    for (const v of ['20.19.0', 'v22.12.0', '22.23.2', '24.0.0']) assert.equal(unsupportedNode(v), null, v);
  });

  it('requireSupportedNode prints the message and exits 1', () => {
    const out: string[] = [];
    assert.throws(() => requireSupportedNode('20.0.0', (code) => { throw new Error(`exit ${code}`); }, (s) => out.push(s)), /exit 1/);
    assert.match(out.join(''), /this is Node 20\.0\.0/);
    requireSupportedNode('22.23.2', () => { throw new Error('no'); }, () => { throw new Error('no'); });
  });
});
