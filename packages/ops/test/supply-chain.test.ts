import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The three pnpm protections docs/ARCHITECTURE.md (Security) claims, proven by behaviour on the repo's own
// settings: each install below runs offline against a local registry and a local git repository.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
const npmrc = readFileSync(join(root, '.npmrc'), 'utf8');
const SETTINGS = ['minimumReleaseAge', 'trustPolicy', 'blockExoticSubdeps'];
const repoSettings = SETTINGS.map((k) => workspace.match(new RegExp(`^${k}: .*$`, 'm'))?.[0] ?? '').join('\n');

const tarball = (dir: string, manifest: object) => {
  mkdirSync(join(dir, 'package'), { recursive: true });
  writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify(manifest));
  return new Promise<Buffer>((done, fail) =>
    execFile('tar', ['czf', '-', '-C', dir, 'package'], { encoding: 'buffer' }, (e, out) => (e ? fail(e) : done(out))),
  );
};

let dir = '';
let server: Server;
let registry = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zeroed-pnpm-'));
  const day = 86_400_000;
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  // trusted: 1.0.0 carried provenance, the later 1.0.1 does not (a takeover's signature).
  // fresh: 1.0.0 is 30 days old, 1.0.1 an hour old.
  const pkgs: Record<string, { v: string; time: string; provenance?: boolean }[]> = {
    trusted: [{ v: '1.0.0', time: at(60 * day), provenance: true }, { v: '1.0.1', time: at(30 * day) }],
    fresh: [{ v: '1.0.0', time: at(30 * day) }, { v: '1.0.1', time: at(3_600_000) }],
  };
  const tgz = new Map<string, Buffer>();
  for (const [name, vs] of Object.entries(pkgs)) for (const { v } of vs) tgz.set(`${name}-${v}`, await tarball(join(dir, `${name}-${v}`), { name, version: v }));
  server = createServer((q, r) => {
    const name = decodeURIComponent(q.url ?? '').slice(1);
    const file = /^[a-z]+\/-\/([a-z]+-[0-9.]+)\.tgz$/.exec(name);
    if (file && tgz.has(file[1]!)) return r.end(tgz.get(file[1]!));
    const vs = pkgs[name];
    if (!vs) return r.writeHead(404).end('{}');
    const meta = {
      name,
      'dist-tags': { latest: vs.at(-1)!.v },
      time: Object.fromEntries([['created', vs[0]!.time], ['modified', vs.at(-1)!.time], ...vs.map((x) => [x.v, x.time])]),
      versions: Object.fromEntries(
        vs.map(({ v, provenance }) => {
          const t = tgz.get(`${name}-${v}`)!;
          const dist = { tarball: `${registry}${name}/-/${name}-${v}.tgz`, shasum: createHash('sha1').update(t).digest('hex'), integrity: `sha512-${createHash('sha512').update(t).digest('base64')}` };
          return [v, { name, version: v, dist: provenance ? { ...dist, attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } : dist }];
        }),
      ),
    };
    r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(meta));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// pnpm in a fresh project holding only the repo's three settings (or none), offline but for the local registry.
let n = 0;
const pnpm = (deps: Record<string, string>, withSettings: boolean) => {
  const app = join(dir, `app-${n++}`);
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0', private: true, dependencies: deps }));
  writeFileSync(join(app, 'pnpm-workspace.yaml'), `packages: []\n${withSettings ? repoSettings : ''}\n`);
  const env = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  const args = ['install', '--ignore-scripts', '--registry', registry, '--store-dir', join(dir, 'store'), '--config.confirmModulesPurge=false'];
  return new Promise<{ ok: boolean; out: string; lock: string }>((done) =>
    execFile('pnpm', args, { cwd: app, env, encoding: 'utf8', timeout: 60_000 }, (e, out, err) => {
      let lock = '';
      try {
        lock = readFileSync(join(app, 'pnpm-lock.yaml'), 'utf8');
      } catch {}
      done({ ok: !e, out: `${out}${err}`, lock });
    }),
  );
};

describe('pnpm supply-chain settings (PNPM-CLAIMS)', () => {
  it('sets all three in pnpm-workspace.yaml and keeps dependency build scripts off', () => {
    expect(workspace).toMatch(/^minimumReleaseAge: 10080$/m);
    expect(workspace).toMatch(/^trustPolicy: no-downgrade$/m);
    expect(workspace).toMatch(/^blockExoticSubdeps: true$/m);
    expect(npmrc).toMatch(/^ignore-scripts=true$/m);
  });

  it('resolves only versions at least 7 days old', async () => {
    const off = await pnpm({ fresh: '^1.0.0' }, false);
    expect(off.ok, off.out).toBe(true);
    expect(off.lock).toContain('fresh@1.0.1');
    const on = await pnpm({ fresh: '^1.0.0' }, true);
    expect(on.ok, on.out).toBe(true);
    expect(on.lock).toContain('fresh@1.0.0');
    expect(on.lock).not.toContain('fresh@1.0.1');
  }, 120_000);

  it('refuses a version published with weaker trust evidence than an earlier one', async () => {
    expect((await pnpm({ trusted: '1.0.1' }, false)).ok).toBe(true);
    const on = await pnpm({ trusted: '1.0.1' }, true);
    expect(on.ok).toBe(false);
    expect(on.out).toContain('ERR_PNPM_TRUST_DOWNGRADE');
  }, 120_000);

  it('refuses a dependency of a dependency from git', async () => {
    const git = join(dir, 'sub');
    mkdirSync(git);
    writeFileSync(join(git, 'package.json'), JSON.stringify({ name: 'sub', version: '1.0.0' }));
    const g = (args: string[]) => new Promise<void>((done, fail) => execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', ...args], { cwd: git }, (e) => (e ? fail(e) : done())));
    await g(['init', '-q']);
    await g(['add', '.']);
    await g(['commit', '-qm', 'sub']);
    const t = await tarball(join(dir, 'parent'), { name: 'parent', version: '1.0.0', dependencies: { sub: `git+file://${git}` } });
    writeFileSync(join(dir, 'parent.tgz'), t);
    expect((await pnpm({ parent: `file:${join(dir, 'parent.tgz')}` }, false)).ok).toBe(true);
    const on = await pnpm({ parent: `file:${join(dir, 'parent.tgz')}` }, true);
    expect(on.ok).toBe(false);
    expect(on.out).toContain('ERR_PNPM_EXOTIC_SUBDEP');
  }, 120_000);
});
