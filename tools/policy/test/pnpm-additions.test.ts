// Unit tests for what Z01 adds to C01's policy: the pump.fun host check (owner rule A02), pnpm-workspace.yaml settings,
// the scoped audit, the SBOM, and the Zeroed scope (B-M30-01 logic 2, 3, 5; docs/MIGRATION.md "Toolchain").
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import { lockIds } from '../age.ts';
import { auditFindings, auditPayload, BULK_ADVISORY_URL, fetchAdvisories, main as auditMain, type HttpPost } from '../audit.ts';
import { runChecks } from '../check.ts';
import { ZEROED_PATHS } from '../config.ts';
import { checkHosts, scanHosts } from '../hosts.ts';
import type { PnpmLock } from '../lockfile.ts';
import { checkPnpmConfig } from '../pnpmconfig.ts';
import { readRepo, type RepoSnapshot } from '../repo.ts';
import { buildSbom, main as sbomMain, npmPurl, sha512Hex } from '../sbom.ts';
import { inZeroed, scopeOf, zeroedJob } from '../scope.ts';
import { capture, codes, goodRepo, goodSnapshot, REPO_ROOT, runBin } from './helpers.ts';

/** Built at run time so this source file writes no pump.fun host (the check reads tools/ too). */
const HOST = ['pump', 'fun'].join('.');
const write = (dir: string, file: string, text: string): void => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

describe('pump.fun-operated hosts (owner rule A02)', () => {
  it('finds a host in a URL, any subdomain, and the bare domain starting a string; not the venue named in prose', () => {
    const hits = [`const u = "https://frontend-api.${HOST}/coins";`, `fetch('//${HOST}/x')`, `host: "images.${HOST}"`, `connect('${HOST}')`,
      `\`${HOST}:443\``, `"${HOST}"`, `ws = 'wss://${HOST.toUpperCase()}'`, ['IMAGES', 'Pump', 'Fun'].join('.'), `x = "${HOST}?a=1"`, `y = '${HOST}#h'`];
    for (const line of hits) assert.deepEqual(codes(scanHosts(line, 'f.ts')), ['E_PUMP_FUN_HOST'], line);
    const misses = [`// the ${HOST} bonding curve`, `label = "Pump.fun"`, `"${HOST}ny"`, `x.${HOST}ction`, `not${HOST}`, `const venue = 'pumpfun_curve';`,
      `"${HOST} program"`, `'pump' + '.fun'`];
    for (const line of misses) assert.deepEqual(scanHosts(line, 'f.ts'), [], line);
    const f = scanHosts(`ok\nconst u = "https://frontend-api.${HOST}/coins";\n`, 'a.ts');
    assert.deepEqual(f.map((x) => `${x.file} ${x.message}`), [`a.ts:2 "//frontend-api.${HOST}" is a pump.fun-operated host; bot and research code makes no request to pump.fun (owner rule A02)`]);
  });

  it('reads every checked file but Markdown and the fixtures; Zeroed\'s paths only with --include-zeroed', () => {
    const repo = goodRepo();
    try {
      const url = `https://${HOST}/coin/x`;
      for (const f of ['packages/engine/src/a.ts', 'tools/x.mjs', 'ops-new/c.json', 'apps/web/src/b.tsx', 'docs/handover/x.ts', 'README.md', 'tools/policy/test/fixtures/x.ts']) {
        write(repo.dir, f, `const u = "${url}";\n`);
      }
      const files = ['packages/engine/src/a.ts', 'tools/x.mjs', 'ops-new/c.json', 'apps/web/src/b.tsx', 'docs/handover/x.ts', 'README.md', 'tools/policy/test/fixtures/x.ts'];
      assert.deepEqual(checkHosts(repo.dir, files).map((x) => x.file), ['ops-new/c.json:1', 'packages/engine/src/a.ts:1', 'tools/x.mjs:1']);
      assert.deepEqual(checkHosts(repo.dir, files, scopeOf(true)).map((x) => x.file),
        ['apps/web/src/b.tsx:1', 'docs/handover/x.ts:1', 'ops-new/c.json:1', 'packages/engine/src/a.ts:1', 'tools/x.mjs:1']);
    } finally { repo.remove(); }
  });

  it('a deliberately bad commit (a pump.fun request in the engine) fails the policy check with E_PUMP_FUN_HOST and nothing else', () => {
    const repo = goodRepo();
    try {
      write(repo.dir, 'packages/engine/src/feed.ts', `export const FEED = 'https://frontend-api-v3.${HOST}/coins/latest';\n`);
      repo.commit('pump.fun request');
      const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /policy: E_PUMP_FUN_HOST packages\/engine\/src\/feed\.ts:1: /);
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_PUMP_FUN_HOST']);
    } finally { repo.remove(); }
  });

  it('this repository has none outside Zeroed\'s paths; Zeroed\'s app link, a sandbox probe and recorded image URLs are reported with --include-zeroed', () => {
    const files = gitFiles();
    assert.deepEqual(checkHosts(REPO_ROOT, files), []);
    const zeroed = [...new Set(checkHosts(REPO_ROOT, files, scopeOf(true)).map((x) => x.file.replace(/:\d+$/, '')))];
    assert.deepEqual(zeroed, ['apps/web/src/components/TokenActions.tsx', 'apps/web/test/app-trade.test.ts',
      'docs/handover/sandbox/supervisor/files/bundle_probe.py', 'docs/handover/sandbox/supervisor/files/jrec.json',
      'docs/handover/sandbox/supervisor/files/jrec2.json', 'docs/handover/sandbox/supervisor/files/research/empirical-data/live/snapshots.jsonl',
      'research/empirical/backfill/meta.json']);
  });
});

/** The repository's tracked and untracked-not-ignored plain files (no links), as check.ts lists them. */
function gitFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0').filter((f) => {
      try {
        return f !== '' && lstatSync(join(REPO_ROOT, f)).isFile();
      } catch {
        return false;
      }
    });
}

describe('pnpm-workspace.yaml settings', () => {
  const ws = (text: string): RepoSnapshot => {
    const s = goodSnapshot();
    s.workspace = readRepoYaml(text);
    return s;
  };
  const base = new Set(['typescript@6.0.3', 'vitest@5.0.3']);

  it('passes the good fixture and this repository', () => {
    assert.deepEqual(checkPnpmConfig(goodSnapshot(), ['pnpm-workspace.yaml'], base), []);
    const repo = readRepo(REPO_ROOT).snapshot;
    const baseLock = lockIds(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8'));
    assert.deepEqual(checkPnpmConfig(repo, ['pnpm-workspace.yaml'], baseLock), []);
  });

  it('requires the file, strictDepBuilds, blockExoticSubdeps and a minimumReleaseAge of at least 14 days in minutes', () => {
    assert.deepEqual(codes(checkPnpmConfig({ ...goodSnapshot(), workspace: null }, [], base)), ['E_PNPM_CONFIG']);
    assert.deepEqual(codes(checkPnpmConfig({ ...goodSnapshot(), workspace: ['a'] }, [], base)), ['E_PNPM_CONFIG']);
    const good = 'packages:\n  - packages/*\nminimumReleaseAge: 20160\nstrictDepBuilds: true\nblockExoticSubdeps: true\n';
    assert.deepEqual(checkPnpmConfig(ws(good), [], base), []);
    assert.deepEqual(checkPnpmConfig(ws(good.replace('20160', '43200')), [], base), [], 'longer is allowed');
    for (const bad of [good.replace('20160', '20159'), good.replace('20160', '14d'), good.replace('20160', '1.5e4'), good.replace('minimumReleaseAge: 20160\n', ''),
      good.replace('strictDepBuilds: true', 'strictDepBuilds: false'), good.replace('strictDepBuilds: true\n', ''), good.replace('blockExoticSubdeps: true', 'blockExoticSubdeps: "yes"')]) {
      assert.deepEqual(codes(checkPnpmConfig(ws(bad), [], base)), ['E_PNPM_CONFIG'], bad);
    }
  });

  it('refuses every key that would loosen the install', () => {
    const good = 'minimumReleaseAge: 20160\nstrictDepBuilds: true\nblockExoticSubdeps: true\n';
    for (const line of ['allowBuilds:\n  esbuild: true', 'onlyBuiltDependencies:\n  - esbuild', 'dangerouslyAllowAllBuilds: true', 'ignoreScripts: false',
      'registry: https://evil.example/', 'overrides:\n  a: 1.0.0', 'packageExtensions: x', 'patchedDependencies: x', 'pnpmfile: x.cjs', 'nodeLinker: hoisted',
      'minimumReleaseAgeExclude: x', 'auditConfig:\n  ignoreGhsas:\n    - GHSA-x']) {
      assert.deepEqual(codes(checkPnpmConfig(ws(`${good}${line}\n`), [], base)), ['E_PNPM_CONFIG'], line);
    }
  });

  it('excludes from the 14-day rule only exact versions in the base lockfile or under "Age exceptions"', () => {
    const good = 'minimumReleaseAge: 20160\nstrictDepBuilds: true\nblockExoticSubdeps: true\nminimumReleaseAgeExclude:\n';
    assert.deepEqual(checkPnpmConfig(ws(`${good}  - vitest@5.0.3\n  - typescript@6.0.3\n`), [], base), []);
    assert.deepEqual(checkPnpmConfig(ws(`${good}`), [], base), [], 'an empty list');
    for (const item of ['vitest', "'@scope/*'", "'nx@21.6.4 || 21.6.5'", 'vitest@^5.0.3', 'VITEST@5.0.3', 'vitest@5.0.3+b']) {
      assert.deepEqual(codes(checkPnpmConfig(ws(`${good}  - ${item}\n`), [], base)), ['E_AGE_EXCLUDE'], item);
    }
    assert.deepEqual(codes(checkPnpmConfig(ws(`${good}  - left-pad@1.3.0\n`), [], base)), ['E_AGE_EXCLUDE'], 'a new version, not reviewed');
    assert.deepEqual(codes(checkPnpmConfig(ws(`${good}  - vitest@5.0.3\n`), [], null)), ['E_AGE_EXCLUDE'], 'no base ref: fails closed');
    const s = ws(`${good}  - left-pad@1.3.0\n`);
    s.dependenciesMd = `${s.dependenciesMd as string}| \`left-pad@1.3.0\` | GHSA-0000-0000-0000 (made up) | Sup |\n`;
    assert.deepEqual(checkPnpmConfig(s, [], base), [], 'a reviewed age exception');
  });

  it('refuses a pnpmfile and a second pnpm-workspace.yaml anywhere but the fixtures', () => {
    const findings = checkPnpmConfig(goodSnapshot(), ['.pnpmfile.cjs', 'packages/engine/.pnpmfile.mjs', 'pnpmfile.js', 'packages/engine/pnpm-workspace.yaml',
      'tools/policy/test/fixtures/good/pnpm-workspace.yaml', 'tools/policy/test/fixtures/x/.pnpmfile.cjs', 'docs/pnpmfile.md'], base);
    assert.deepEqual(findings.map((f) => `${f.code} ${f.file}`), ['E_PNPMFILE .pnpmfile.cjs', 'E_PNPMFILE packages/engine/.pnpmfile.mjs', 'E_PNPMFILE pnpmfile.js',
      'E_PNPM_CONFIG packages/engine/pnpm-workspace.yaml']);
  });
});

/** pnpm-workspace.yaml text as readRepo reads it. */
function readRepoYaml(text: string): RepoSnapshot['workspace'] {
  const repo = goodRepo();
  try {
    writeFileSync(join(repo.dir, 'pnpm-workspace.yaml'), text);
    return readRepo(repo.dir).snapshot.workspace;
  } finally { repo.remove(); }
}

describe('security audit of the checked workspace projects', () => {
  const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const pacing = () => { const p = { t: 0, sleeps: [] as number[], nowMs: () => p.t, sleep: async (ms: number) => { p.sleeps.push(ms); p.t += ms; } }; return p; };

  it('posts {name: [versions]} by real name, sorted', () => {
    assert.deepEqual(auditPayload(['b@2.0.0', 'a@1.0.0', '@s/c@3.0.0', 'a@1.1.0', 'nover']), { '@s/c': ['3.0.0'], a: ['1.0.0', '1.1.0'], b: ['2.0.0'] });
  });

  it('fails on advisories of severity low and above, and on any it cannot read; info passes', () => {
    const payload = { uuid: ['7.0.3'] };
    const adv = (severity: unknown) => ({ uuid: [{ id: 1, url: 'https://github.com/advisories/GHSA-x', title: 't', severity, vulnerable_versions: '<11.1.1' }] });
    for (const sev of ['low', 'moderate', 'high', 'critical', undefined]) assert.deepEqual(codes(auditFindings(adv(sev), payload)), ['E_AUDIT'], String(sev));
    assert.deepEqual(auditFindings(adv('info'), payload), []);
    assert.deepEqual(auditFindings({}, payload), []);
    assert.equal(auditFindings(adv('moderate'), payload)[0]?.message,
      'moderate advisory https://github.com/advisories/GHSA-x: t (vulnerable <11.1.1; installed 7.0.3)');
    assert.throws(() => auditFindings([], payload), /not a JSON object/);
    assert.throws(() => auditFindings(null, payload), /not a JSON object/);
    assert.throws(() => auditFindings({ uuid: 'x' }, payload), /not a list/);
  });

  it('posts once to the Bulk Advisory endpoint; retries 429, 403, 5xx and network errors with backoff and Retry-After; stops at the third failure', async () => {
    const calls: Array<[string, string]> = [];
    const post: HttpPost = async (url, body) => { calls.push([url, body]); return ok({}); };
    assert.deepEqual(await fetchAdvisories({ a: ['1.0.0'] }, post, pacing()), {});
    assert.deepEqual(calls, [[BULK_ADVISORY_URL, '{"a":["1.0.0"]}']]);
    assert.equal(BULK_ADVISORY_URL, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    let n = 0;
    const p = pacing();
    const flaky: HttpPost = async () => { n++; if (n === 1) return ok('', 429, { 'retry-after': '10' }); if (n === 2) throw new Error('ECONNRESET'); return ok({ x: [] }); };
    assert.deepEqual(await fetchAdvisories({}, flaky, p), { x: [] });
    assert.deepEqual(p.sleeps, [10_000, 4000], 'Retry-After 10 s over the 2 s backoff, then 4 s');
    let m = 0;
    await assert.rejects(fetchAdvisories({}, async () => { m++; return ok('', 503); }, pacing()), /registry answered 503/);
    assert.equal(m, 3);
    let k = 0;
    await assert.rejects(fetchAdvisories({}, async () => { k++; return ok('', 404); }, pacing()), /registry answered 404/);
    assert.equal(k, 1, 'a 404 is not retried');
    await assert.rejects(fetchAdvisories({}, async () => ok('{'), pacing()), /not JSON/);
    await assert.rejects(fetchAdvisories({}, async () => ok('', 429, { 'retry-after': '3600' }), pacing()), /longer than 120000 ms, stopping/);
  });

  it('main: audits the checked projects\' packages only (Zeroed\'s with --include-zeroed), and fails closed', async () => {
    const repo = goodRepo();
    try {
      const lockPath = join(repo.dir, 'pnpm-lock.yaml');
      writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace("  packages/types: {}\n", "  packages/types: {}\n\n  apps/web:\n    dependencies:\n      uuid:\n        specifier: 7.0.3\n        version: 7.0.3\n")
        .replace('\nsnapshots:\n', '\n  uuid@7.0.3:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  uuid@7.0.3: {}\n'));
      const bodies: string[] = [];
      const post: HttpPost = async (_url, body) => { bodies.push(body); return ok(JSON.parse(body).uuid ? { uuid: [{ severity: 'moderate', url: 'u', title: 't', vulnerable_versions: '<11.1.1' }] } : {}); };
      const io = capture();
      assert.equal(await auditMain([repo.dir], io, post, pacing()), 0);
      assert.deepEqual(JSON.parse(bodies[0] as string), { '@solana/addresses': ['8.4.0'], '@solana/kit': ['8.4.0'], typescript: ['6.0.3'] });
      assert.match(io.text(), /no advisories of severity low or above for 3 package version\(s\)/);
      const io2 = capture();
      assert.equal(await auditMain(['--include-zeroed', repo.dir], io2, post, pacing()), 1);
      assert.match(io2.text(), /E_AUDIT uuid: moderate advisory u: t \(vulnerable <11\.1\.1; installed 7\.0\.3\)/);
      const io3 = capture();
      assert.equal(await auditMain([repo.dir], io3, async () => ok('', 404), pacing()), 1);
      assert.match(io3.text(), /E_AUDIT_FETCH registry: registry answered 404 for the advisory request; no further requests were made/);
      writeFileSync(lockPath, 'a: [\n');
      const io4 = capture();
      assert.equal(await auditMain([repo.dir], io4, post, pacing()), 1);
      assert.match(io4.text(), /E_LOCK_PARSE/);
    } finally { repo.remove(); }
  });
});

describe('SBOM (CycloneDX 1.6)', () => {
  const hash64 = Buffer.alloc(64, 7).toString('base64');

  it('writes npm package URLs and sha512 hex digests', () => {
    assert.equal(npmPurl('foobar', '12.3.1'), 'pkg:npm/foobar@12.3.1');
    assert.equal(npmPurl('@angular/animation', '12.3.1'), 'pkg:npm/%40angular/animation@12.3.1');
    assert.equal(sha512Hex(`sha512-${hash64}`), '07'.repeat(64));
    assert.equal(sha512Hex('sha1-abc'), null);
    assert.equal(sha512Hex(`sha512-${Buffer.alloc(32).toString('base64')}`), null, 'not 64 bytes');
    assert.equal(sha512Hex(undefined), null);
  });

  it('lists the production closure of the checked projects with hashes and licences, and omits development dependencies', () => {
    const s = goodSnapshot();
    const lock = s.lock as PnpmLock;
    for (const id of Object.keys(lock.packages)) lock.packages[id] = { resolution: { integrity: `sha512-${hash64}` } };
    const doc = buildSbom(s, lock, new Map([['@solana/kit@8.4.0', 'MIT']])) as { components: Array<Record<string, unknown>> } & Record<string, unknown>;
    assert.equal(doc['bomFormat'], 'CycloneDX');
    assert.equal(doc['specVersion'], '1.6');
    assert.deepEqual(doc['metadata'], { component: { type: 'application', name: 'fixture', version: '0.0.0' } });
    assert.deepEqual(doc.components.map((c) => c['purl']), ['pkg:npm/%40solana/addresses@8.4.0', 'pkg:npm/%40solana/kit@8.4.0'], 'typescript is a dev dependency');
    assert.deepEqual(doc.components[1], { type: 'library', name: '@solana/kit', version: '8.4.0', purl: 'pkg:npm/%40solana/kit@8.4.0',
      hashes: [{ alg: 'SHA-512', content: '07'.repeat(64) }], licenses: [{ expression: 'MIT' }] });
    assert.equal('licenses' in (doc.components[0] as object), false, 'no licence known: none written');
    assert.equal(JSON.stringify(buildSbom(s, lock, new Map())), JSON.stringify(buildSbom(s, lock, new Map())), 'same input, same bytes');
    lock.packages['@solana/kit@8.4.0'] = { resolution: { integrity: 'sha512-short' } };
    assert.throws(() => buildSbom(s, lock, new Map()), /@solana\/kit@8\.4\.0 has no sha512 integrity/);
  });

  it('the CLI writes this repository\'s document, and fails on a broken lockfile', () => {
    const io = capture();
    assert.equal(sbomMain([REPO_ROOT], io), 0);
    const doc = JSON.parse(io.text()) as Record<string, unknown>;
    assert.equal(doc['bomFormat'], 'CycloneDX');
    const repo = goodRepo();
    try {
      const io2 = capture();
      assert.equal(sbomMain([repo.dir], io2), 1, 'the fixture integrities are not real sha512 digests');
      assert.match(io2.text(), /E_SBOM pnpm-lock\.yaml: @solana\/addresses@8\.4\.0 has no sha512 integrity/);
      writeFileSync(join(repo.dir, 'pnpm-lock.yaml'), 'a: [\n');
      const io3 = capture();
      assert.equal(sbomMain([repo.dir], io3), 1);
      assert.match(io3.text(), /E_LOCK_PARSE/);
    } finally { repo.remove(); }
  });
});

describe('Zeroed scope', () => {
  it('names Zeroed\'s paths, workflows and jobs; everything else is checked', () => {
    for (const p of ['apps/web/src/a.ts', 'packages/core/src/a.ts', 'packages/worker/x', 'research/a.mjs', 'ops/host/x.sh', 'docs/handover/a', 'brand/x.svg',
      '.github/workflows/deploy.yml']) {
      assert.equal(inZeroed(p), true, p);
    }
    for (const p of ['packages/engine/src/a.ts', 'packages/types/src/a.ts', 'packages/corex/a.ts', 'tools/policy/a.ts', 'docs/blueprint/FACTS.json', 'docs/MIGRATION.md',
      '.github/workflows/ci.yml', '.github/workflows/guard.yml', '.github/workflows/new.yml', 'package.json', 'appsx/a.ts']) {
      assert.equal(inZeroed(p), false, p);
    }
    assert.equal(zeroedJob('.github/workflows/ci.yml', 'historical-data'), true);
    assert.equal(zeroedJob('.github/workflows/ci.yml', 'check'), false);
    assert.equal(zeroedJob('.github/workflows/guard.yml', 'historical-data'), false);
    assert.equal(scopeOf(false)('apps/x'), false);
    assert.equal(scopeOf(true)('apps/x'), true);
    assert.equal(scopeOf(true).job('.github/workflows/ci.yml', 'historical-data'), true);
    assert.ok(ZEROED_PATHS.every((p) => p.endsWith('/')), 'directories only');
  });

  it('symbolic links in Zeroed\'s paths are not followed or reported; outside them they stop the check', () => {
    const repo = goodRepo();
    try {
      write(repo.dir, 'research/real.txt', 'x\n');
      symlinkSync('real.txt', join(repo.dir, 'research/link.txt'));
      symlinkSync('/dev/zero', join(repo.dir, 'research/endless'));            // read through, it would never end
      repo.commit('zeroed links');
      assert.deepEqual(runChecks(repo.dir, 'main'), []);
      assert.deepEqual(runChecks(repo.dir, 'main', { includeZeroed: true }).map((f) => `${f.code} ${f.file}`), ['E_SYMLINK research/endless', 'E_SYMLINK research/link.txt']);
      symlinkSync('../research/real.txt', join(repo.dir, 'packages/link.txt'));
      repo.commit('a link outside');
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`), ['E_SYMLINK packages/link.txt']);
    } finally { repo.remove(); }
  });

  it('this repository passes; --include-zeroed reports what Zeroed\'s paths would fail (the CLI says so)', () => {
    const r = runBin('check.ts', [REPO_ROOT], REPO_ROOT, { POLICY_BASE_REF: 'HEAD' });
    assert.equal(r.status, 0, r.stderr);
    const z = runBin('check.ts', ['--include-zeroed', REPO_ROOT], REPO_ROOT, { POLICY_BASE_REF: 'HEAD' });
    assert.equal(z.status, 1);
    assert.match(z.stderr, /^policy: E_SYMLINK research\/historical\/rpcscan\//m);
    assert.match(z.stderr, /finding\(s\) \(Zeroed paths included\)\n$/);
  });
});
