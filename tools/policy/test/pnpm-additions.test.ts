// Unit tests for what Z01 adds to C01's policy: the pump.fun host check (owner rule A02), pnpm-workspace.yaml settings,
// the scoped audit, the SBOM, and the Zeroed scope (B-M30-01 logic 2, 3, 5; docs/MIGRATION.md "Toolchain").
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import { lockIds } from '../age.ts';
import {
  addedVersions, auditFindings, auditPayload, blockingFindings, BULK_ADVISORY_URL, fetchAdvisories, main as auditMain, reportOnly, type HttpPost,
} from '../audit.ts';
import { runChecks } from '../check.ts';
import { ZEROED_DIRS, ZEROED_FILES_MANIFEST } from '../config.ts';
import { finding } from '../finding.ts';
import { gitAt, parseAddedLines, type Git } from '../git.ts';
import { scanGitattributes } from '../gitattributes.ts';
import { isGuarded } from '../drift.ts';
import { checkHosts, decodeEscapes, EVIDENCE_FILES, GIT_BINARY_PROBE, hostScanned, isSourceLike, scanHosts, stripComment } from '../hosts.ts';
import { checkImports, looseModuleRefs } from '../imports.ts';
import type { PnpmLock } from '../lockfile.ts';
import { checkManifests } from '../manifests.ts';
import { checkPnpmConfig } from '../pnpmconfig.ts';
import { readRepo, type RepoSnapshot } from '../repo.ts';
import { buildSbom, main as sbomMain, npmPurl, sha512Hex } from '../sbom.ts';
import { inZeroed, inZeroedPackage, safetyLinesOf, scopeOf, structureScopeOf, zeroedJob } from '../scope.ts';
import { capture, codes, editText, goodRepo, goodSnapshot, REPO_ROOT, runBin, type TempRepo } from './helpers.ts';

/** Built at run time so this source file writes no pump.fun host (the check reads tools/ too). */
const HOST = ['pump', 'fun'].join('.');
/** A file the Zeroed manifest holds (tools/policy/zeroed-files.txt), so the scoped checks skip it. */
const ZEROED_FILE = 'apps/web/src/main.tsx';
const write = (dir: string, file: string, text: string): void => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

describe('pump.fun-operated hosts (owner rule A02)', () => {
  it('finds a host in a URL, any subdomain, and the bare domain starting a string; not the venue named in prose', () => {
    const CAPS = ['Pump', 'fun'].join('.');
    const hits = [`const u = "https://frontend-api.${HOST}/coins";`, `fetch('//${HOST}/x')`, `host: "images.${HOST}"`, `connect('${HOST}')`,
      `\`${HOST}:443\``, `"${HOST}"`, `ws = 'wss://${HOST.toUpperCase()}'`, ['IMAGES', 'Pump', 'Fun'].join('.'), `x = "${HOST}?a=1"`, `y = '${HOST}#h'`,
      // Red team RT-04 (supervisor ruling 8): a trailing dot, any letter case, and the bare domain as a value.
      `const u = "https://frontend-api.${HOST}./coins";`, `host: "frontend-api.${HOST}."`, `PUMP_HOST=frontend-api.${HOST}.`,
      `label = "${CAPS}"`, `x = '${CAPS}/coin'`, `host: ${HOST}`, `  host: ${CAPS}.`, `PUMP_HOST=${HOST}`, `PUMP_HOST=${CAPS}`,
      `${HOST}/coins`, `${HOST}`, `"api": "${CAPS}:443"`, `hosts = ["${HOST}","${CAPS}"]`,
      // Ruling 5.4: a quoted value followed by whitespace counts now too.
      `"${HOST} program"`, `"topic": "${CAPS} coin creation (Token-2022)"`];
    for (const line of hits) assert.deepEqual(codes(scanHosts(line, 'f.ts')), ['E_PUMP_FUN_HOST'], line);
    const misses = [`// the ${HOST} bonding curve`, `"${HOST}ny"`, `x.${HOST}ction`, `not${HOST}`, `const venue = 'pumpfun_curve';`,
      `'pump' + '.fun'`, `// venue: ${HOST} bonding curve`, `// claim: the ${CAPS} label routes it`,
      `x = "${HOST}.io/x"`, `host: ${HOST}ny`, `note = "see [${CAPS}](https://x/y)"`];
    for (const line of misses) assert.deepEqual(scanHosts(line, 'f.ts'), [], line);
    const f = scanHosts(`ok\nconst u = "https://frontend-api.${HOST}/coins";\n`, 'a.ts');
    assert.deepEqual(f.map((x) => `${x.file} ${x.message}`), [`a.ts:2 "//frontend-api.${HOST}" is a pump.fun-operated host; bot and research code makes no request to pump.fun (owner rule A02)`]);
  });

  it('finds the bare domain after whitespace with a path, and as a curl or wget argument (red team RT2-02, ruling 3.2)', () => {
    // One form each; every one passed before.
    for (const line of [`curl -s ${HOST}/api/coins`, `wget ${HOST}`, `wget -qO- "${HOST}"`, `curl -fsSL --retry 3 ${HOST}`, `  curl -H 'x: y' frontend-api.${HOST}`,
      `resp=$(curl ${HOST.toUpperCase()}/coins)`, `GET ${HOST}/api/coins/latest`, `\tsee ${HOST}/board`]) {
      assert.deepEqual(codes(scanHosts(line, 'run.sh')), ['E_PUMP_FUN_HOST'], line);
    }
    // A comment naming the on-chain program is not a request target.
    for (const line of [`// The ${HOST} bonding curve program (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P) holds the reserves.`,
      `# ${HOST} bonding curve accounts are read from chain, never from ${HOST} itself`, `// curl is not used for the ${HOST} program`]) {
      assert.deepEqual(scanHosts(line, 'a.ts'), [], line);
    }
  });

  it('ruling 5.4 forms: whitespace around = and :, ; ) whitespace or :port after, any shell argument, decoded escapes (RT3-04)', () => {
    const hit = (line: string, file = 'f.ts'): void => assert.deepEqual(codes(scanHosts(line, file)), ['E_PUMP_FUN_HOST'], `${file}: ${line}`);
    const miss = (line: string, file = 'f.ts'): void => assert.deepEqual(scanHosts(line, file), [], `${file}: ${line}`);
    // Whitespace around = and :
    hit(`host = ${HOST}`); hit(`HOST =${HOST}`); hit(`host:${HOST}`); hit(`host :  ${HOST}`);
    // ; ) whitespace :port or end of line after the domain
    hit(`H=${HOST};`); hit(`url = ${HOST})`); hit(`h = ${HOST} 443`); hit(`target: ${HOST}:443`); hit(`H=${HOST}`);
    // Any shell argument, in files whose lines run as commands
    for (const file of ['run.sh', 'ci.yml', 'zeroed-x.service', 'Dockerfile']) {
      hit(`nc ${HOST} 443`, file); hit(`openssl s_client -connect ${HOST}:443`, file); hit(`ping -c1 ${HOST}`, file); hit(`dig +short ${HOST}`, file);
    }
    miss(`nc ${HOST} 443`, 'ops/bin/probe-tool');
    assert.deepEqual(codes(scanHosts(`#!/usr/bin/env bash\nnc ${HOST} 443\n`, 'ops/bin/probe-tool')), ['E_PUMP_FUN_HOST'], 'a #! shell script');
    miss(`nc ${HOST} 443`, 'notes.ts');
    // Escape-encoded literals are decoded first
    // Built from pieces, so this file holds no encoded host of its own (the check reads tools/ too).
    const enc = (sep: string): string => ['pump', 'fun'].join(sep);
    hit(`fetch('${enc('\\u002e')}/api')`); hit(`fetch("\\x70${'ump'}.fun/x")`); hit(`u = 'https%3A%2F%2F${enc('%2E')}%2Fcoins'`);
    hit(`h = '${enc('\\u{2e}')}'`);
    // A comment naming the on-chain program stays quiet, in code and in shell
    miss(`// The ${HOST} bonding curve program holds the reserves`); miss(`# the ${HOST} bonding curve program`, 'run.sh');
    miss(`const x = 1; // reads the ${HOST} bonding curve from chain`);
    assert.equal(decodeEscapes('a\\u0041b\\x42c%43\\u{44}'), 'aAbBcCD');
    assert.equal(stripComment('x = 1 # tail'), 'x = 1 ');
    assert.equal(stripComment('u = "https://a/b" // tail'), 'u = "https://a/b" ');
    assert.equal(stripComment('  # whole line'), '');
  });

  it('decides binary by extension and git\'s view, never by a NUL alone; a NUL in code or config is E_BINARY_SOURCE (RT3-01, ruling 5.1)', () => {
    const repo = goodRepo();
    try {
      // The red team's case: a new .mjs file with a NUL in a comment and a pump.fun fetch. It parses and lints.
      write(repo.dir, 'research/x/feed.mjs', `// \0\nexport const f = () => fetch('https://frontend-api.${HOST}/coins');\n`);
      repo.commit('a NUL to hide a fetch');
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`), ['E_BINARY_SOURCE research/x/feed.mjs', 'E_PUMP_FUN_HOST research/x/feed.mjs:2']);
    } finally { repo.remove(); }
    const body = `x = "https://${HOST}/coins"\n`;
    assert.equal(hostScanned('ops/bin/tool', `#!/bin/sh\n\0${body}`), true, 'a #! file is read whatever it holds');
    assert.equal(isSourceLike('ops/bin/tool', `#!/bin/sh\n\0`), true);
    assert.equal(isSourceLike('prod.env', ''), true);
    assert.equal(hostScanned('data/blob.dat', `\0${body}`), false, 'not code or config, NUL early: binary in git\'s view');
    assert.equal(hostScanned('data/blob.dat', `${'a'.repeat(GIT_BINARY_PROBE)}\0${body}`), true, 'a NUL past git\'s probe: text in git\'s view');
    assert.equal(hostScanned('web/logo.png', body), false, 'by extension');
  });

  it('reads every text file but binaries, images, Markdown, non-code under docs/ and the named evidence files (ruling 3.2)', () => {
    const CAPS = ['Pump', 'fun'].join('.');
    const repo = goodRepo();
    try {
      const body = `x = "${CAPS}"\ncurl -s ${HOST}/api/coins\n`;
      const read = ['scanner/main.go', 'svc/lib.rs', 'tools-x/a.rb', 'ops-x/zeroed-feed.service', 'ops-x/zeroed-feed.timer', 'ops-x/nginx.conf', 'ops-x/app.ini',
        'db/seed.sql', 'web/index.html', 'prod.env', 'ops-x/.env', 'ops-x/bin/zeroed-pull', 'packages/x/config.json', 'packages/x/notes.txt', 'packages/x/data.jsonl',
        'docs/x/feed.ts', 'docs/x/probe.py', 'docs/x/run-me'];
      const skipped = ['docs/blueprint/FACTS.json', 'docs/x/notes.txt', 'packages/x/README.md', 'docs/x/README.md', 'web/logo.png', 'web/logo.svg', 'packages/x/blob.dat'];
      for (const f of [...read, ...skipped]) write(repo.dir, f, f === 'ops-x/bin/zeroed-pull' || f === 'docs/x/run-me' ? `#!/usr/bin/env bash\n${body}` : body);
      write(repo.dir, 'packages/x/blob.dat', `\0${body}`);
      const files = [...read, ...skipped];
      assert.deepEqual([...new Set(checkHosts(repo.dir, files).map((x) => x.file.replace(/:\d+$/, '')))].sort(), [...read].sort());
      assert.equal(hostScanned('docs/x/notes.txt', body), false);
      assert.equal(hostScanned('docs/x/run-me', `#!/bin/sh\n${body}`), true, 'code under docs/ by its #! line');
      assert.equal(hostScanned('packages/x/blob.dat', `a\0b`), false, 'a NUL byte early in a file that is not code or config: binary in git\'s view');
      for (const [file, reason] of Object.entries(EVIDENCE_FILES)) {
        assert.ok(reason.length > 10, `${file} names its reason`);
        assert.equal(hostScanned(file, body), false, file);
      }
    } finally { repo.remove(); }
    // The real evidence file passes as it is, quoted labels and all: docs/ non-code is not read.
    const facts = readFileSync(join(REPO_ROOT, 'docs/blueprint/FACTS.json'), 'utf8');
    assert.ok(facts.includes(`'${CAPS}'`), 'FACTS.json quotes the route label verbatim');
    assert.deepEqual(checkHosts(REPO_ROOT, ['docs/blueprint/FACTS.json']), []);
    assert.notDeepEqual(scanHosts(facts, 'packages/x/config.json'), [], 'the same text in package configuration fails');
  });

  it('reads new files everywhere, and an old Zeroed file only on its added lines (ruling 3.1)', () => {
    const repo = goodRepo();
    try {
      const url = `https://${HOST}/coin/x`;
      // ZEROED_FILE is on the manifest (an existing Zeroed file); the others are not, so a new file under the same
      // folder, a Zeroed-only package folder included, is read (round 1 review F4, red team RT-01, ruling 3.1).
      const files = ['packages/engine/src/a.ts', 'tools/x.mjs', 'ops-new/c.json', 'apps/web/src/new-feed.ts', 'research/new/feed.ts', 'ops/recorder/feed.ts',
        'packages/worker/src/new-feed.ts', ZEROED_FILE, 'README.md', 'tools/policy/test/fixtures/x.ts'];
      for (const f of files) write(repo.dir, f, `const u = "${url}";\nconst v = "${url}";\n`);
      assert.deepEqual([...new Set(checkHosts(repo.dir, files).map((x) => x.file.replace(/:\d+$/, '')))],
        ['apps/web/src/new-feed.ts', 'ops-new/c.json', 'ops/recorder/feed.ts', 'packages/engine/src/a.ts', 'packages/worker/src/new-feed.ts', 'research/new/feed.ts', 'tools/x.mjs']);
      assert.deepEqual(checkHosts(repo.dir, [ZEROED_FILE], safetyLinesOf(false, new Map([[ZEROED_FILE, new Set([2])]]))).map((x) => x.file), [`${ZEROED_FILE}:2`],
        'only the added line of an old Zeroed file');
      assert.deepEqual(checkHosts(repo.dir, [ZEROED_FILE], safetyLinesOf(true, new Map())).map((x) => x.file), [`${ZEROED_FILE}:1`, `${ZEROED_FILE}:2`]);
      assert.deepEqual(checkHosts(repo.dir, [ZEROED_FILE], safetyLinesOf(false, null)).length, 2, 'no merge base: read in full (fails closed)');
    } finally { repo.remove(); }
  });

  it('a deliberately bad commit (a pump.fun request in the engine) fails the policy check with E_PUMP_FUN_HOST and nothing else', () => {
    const repo = goodRepo();
    try {
      write(repo.dir, 'packages/engine/src/feed.ts', `export const FEED = 'https://frontend-api-v3.${HOST}/coins/latest';\n`);
      repo.commit('request to the venue host');
      const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /policy: E_PUMP_FUN_HOST packages\/engine\/src\/feed\.ts:1: /);
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_PUMP_FUN_HOST']);
    } finally { repo.remove(); }
  });

  it('this repository has none outside old Zeroed lines; --include-zeroed reports the Zeroed files with a host (ruling 3.2 list)', () => {
    const files = gitFiles();
    assert.deepEqual(checkHosts(REPO_ROOT, files), []);
    const zeroed = [...new Set(checkHosts(REPO_ROOT, files, safetyLinesOf(true, null)).map((x) => x.file.replace(/:\d+$/, '')))];
    // Every text file is read now (ruling 3.2); docs/ non-code and Markdown are not, and code under docs/ is.
    // Round 5: meta.json is a named evidence file now (ruling 5.5); the wider forms of ruling 5.4 add three docstrings
    // and pf.py's own stop message, all old Zeroed lines.
    assert.deepEqual(zeroed, ['apps/web/src/components/TokenActions.tsx', 'apps/web/test/app-trade.test.ts',
      'docs/handover/sandbox/supervisor/files/bundle_probe.py', 'research/brainstorm/brainstorm2.py', 'research/brainstorm/collect.py',
      'research/brainstorm/pf.py', 'research/launch-probe/pumpdec.py']);
  });

  it('collect.py stops before anything runs, and meta.json is named evidence with its reason (ruling 5.5)', () => {
    const lines = readFileSync(join(REPO_ROOT, 'research/brainstorm/collect.py'), 'utf8').split('\n');
    const first = lines.findIndex((l, i) => i > 0 && l.trim() !== '' && !l.trimStart().startsWith('#'));
    assert.ok(lines[0]?.startsWith('"""') && lines[0].endsWith('"""'), 'a one-line docstring first');
    assert.match(lines[first] ?? '', /^raise SystemExit\(/, 'the first statement after the docstring stops the script');
    assert.match(lines.slice(1, first).join('\n'), /owner rule A02, 2026-10-07: no new requests/);
    assert.ok(lines.slice(first + 1).some((l) => /^import /.test(l)), 'imports come after the stop');
    const reason = EVIDENCE_FILES['research/empirical/backfill/meta.json'] ?? '';
    assert.match(reason, /recorded .* never fetched from/);
    for (const file of Object.keys(EVIDENCE_FILES)) assert.ok(lstatSync(join(REPO_ROOT, file)).isFile(), `${file} exists`);
  });
});

describe('old Zeroed code: structure rules skip it, safety checks read its added lines (supervisor ruling 3.1)', () => {
  /** Puts `file` with `text` on the base branch (main) and brings it into the pull request branch. */
  const onBase = (repo: TempRepo, file: string, text: string): void => {
    repo.git('checkout', '-q', 'main');
    write(repo.dir, file, text);
    repo.commit(`old ${file}`);
    repo.git('checkout', '-q', 'pr');
    repo.git('merge', '-q', '--ff-only', 'main');
  };

  it('RT2-01: a web3 import and a pump.fun fetch appended to research/empirical/lib.mjs fail; its old lines stay quiet', () => {
    const repo = goodRepo();
    try {
      const file = 'research/empirical/lib.mjs';
      assert.equal(inZeroed(file), true, 'on the manifest');
      onBase(repo, file, `import { x } from '../../packages/core/src/x.mjs';\nexport const OLD = 'https://${HOST}/old';\n`);
      assert.deepEqual(runChecks(repo.dir, 'main'), [], 'old lines are quiet');
      editText(repo.dir, file, (t) => `${t}import { Connection } from '@solana/web3.js';\nexport const feed = () => fetch('https://frontend-api.${HOST}/coins');\n`);
      repo.commit('append to an old Zeroed file');
      const found = runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`);
      assert.deepEqual(found, [`E_UNDECLARED_IMPORT ${file}:3`, `E_PUMP_FUN_HOST ${file}:4`]);
    } finally { repo.remove(); }
  });

  it('RT2-01: a curl to the host appended to ops/host/files/usr/local/sbin/zeroed-backup fails', () => {
    const repo = goodRepo();
    try {
      const file = 'ops/host/files/usr/local/sbin/zeroed-backup';
      assert.equal(inZeroed(file), true, 'on the manifest');
      onBase(repo, file, '#!/usr/bin/env bash\nset -euo pipefail\necho backup\n');
      assert.deepEqual(runChecks(repo.dir, 'main'), []);
      editText(repo.dir, file, (t) => `${t}curl -s ${HOST}/api/coins > /tmp/c\n`);
      repo.commit('append a curl');
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`), [`E_PUMP_FUN_HOST ${file}:4`]);
      // Uncommitted edits count too: the diff runs against the working tree.
      editText(repo.dir, file, (t) => `${t}wget ${HOST}\n`);
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => f.file), [`${file}:4`, `${file}:5`]);
    } finally { repo.remove(); }
  });

  it('a new file under packages/worker/ that fetches a pump.fun host fails', () => {
    const repo = goodRepo();
    try {
      write(repo.dir, 'packages/worker/src/feed.ts', `export const FEED = 'https://frontend-api-v3.${HOST}/coins/latest';\n`);
      repo.commit('new worker file');
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`), ['E_PUMP_FUN_HOST packages/worker/src/feed.ts:1']);
    } finally { repo.remove(); }
  });

  it('the reviewer\'s copied worker test passes as a new file: structure rules skip the package, safety checks find nothing (R2-1)', () => {
    const { snapshot } = readRepo(REPO_ROOT);
    const dir = mkdtempSync(join(tmpdir(), 'policy-worker-'));
    try {
      const copied = 'packages/worker/test/copied-account-marks.test.ts';
      write(dir, copied, readFileSync(join(REPO_ROOT, 'packages/worker/test/account-marks.test.ts'), 'utf8'));
      const snap = { ...snapshot, root: dir };
      // What the structure rules would say: the copy imports across packages, as the Zeroed worker does.
      assert.ok(codes(checkImports(snap, [copied], scopeOf(true))).includes('E_IMPORT_PATH'), 'the copy trips the structure rules when they apply');
      assert.deepEqual(checkImports(snap, [copied]), [], 'structure rules skip packages/worker/; its imports are all declared');
      assert.deepEqual(checkHosts(dir, [copied]), []);
      assert.equal(inZeroedPackage(copied), true);
      assert.equal(structureScopeOf(false)(copied), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('safety import rules still read every new file under a Zeroed package folder, and parse-failing old files line by line', () => {
    const { snapshot } = readRepo(REPO_ROOT);
    const dir = mkdtempSync(join(tmpdir(), 'policy-worker-'));
    try {
      const fresh = 'packages/worker/src/new-feed.ts';
      write(dir, fresh, "import { Connection } from '@solana/web3.js';\nimport x from 'left-pad';\nimport { y } from '../../core/src/y.ts';\nexport const z = [Connection, x, y];\n");
      const snap = { ...snapshot, root: dir };
      assert.deepEqual(checkImports(snap, [fresh]).map((f) => `${f.code} ${f.file}`),
        [`E_UNDECLARED_IMPORT ${fresh}:1`, `E_UNDECLARED_IMPORT ${fresh}:2`], 'safety codes only; the cross-package path is a structure rule');
      const old = 'research/empirical/lib.mjs';
      write(dir, old, "this is not { valid javascript\nimport bad from 'left-pad';\n");
      assert.deepEqual(checkImports(snap, [old], structureScopeOf(false), safetyLinesOf(false, new Map([[old, new Set([2])]]))).map((f) => `${f.code} ${f.file}`),
        [`E_UNDECLARED_IMPORT ${old}:2`], 'an unparsable old file is read line by line for its added imports');
      assert.deepEqual(looseModuleRefs("import a from 'a';\nconst b = require(\"b\");\nexport * from 'c';\nawait import(`d`);\n").map((r) => `${r.line}:${r.specifier}`),
        ['1:a', '2:b', '3:c', '4:d']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('RT3-02: a .gitattributes line cannot hide an edit; -diff, binary, diff= and -text are refused (ruling 5.2)', () => {
    const repo = goodRepo();
    try {
      const file = 'research/empirical/lib.mjs';
      onBase(repo, file, 'export const OLD = 1;\n');
      write(repo.dir, '.gitattributes', 'research/** -diff\n');
      editText(repo.dir, file, (t) => `${t}export const feed = () => fetch('https://frontend-api.${HOST}/coins');\n`);
      repo.commit('hide an edit behind -diff');
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`), ['E_GITATTRIBUTES .gitattributes:1', `E_PUMP_FUN_HOST ${file}:2`],
        'git diff --text still shows the hunk, and the attribute is refused');
      assert.equal(isGuarded('.gitattributes'), true);
      assert.equal(isGuarded('research/x/.gitattributes'), true, 'at any depth');
    } finally { repo.remove(); }
    for (const attr of ['-diff', 'binary', 'diff=hide', 'diff=', '-text']) {
      assert.deepEqual(codes(scanGitattributes(`# comment\n*.mjs ${attr}\n`, '.gitattributes')), ['E_GITATTRIBUTES'], attr);
    }
    assert.deepEqual(scanGitattributes('* text=auto eol=lf\n*.png -crlf\n*.sh text\n\n', '.gitattributes'), [], 'other attributes are fine');
  });

  it('a changed old Zeroed file without a hunk is read whole (ruling 5.2)', () => {
    const old = 'research/empirical/lib.mjs';
    const lines = safetyLinesOf(false, new Map([[old, new Set([3])]]), new Set([old, ZEROED_FILE]));
    assert.equal(lines(ZEROED_FILE), 'all', 'changed, no hunk: read whole');
    assert.deepEqual([...(lines(old) as Set<number>)], [3]);
    assert.deepEqual([...(safetyLinesOf(false, new Map(), new Set())(ZEROED_FILE) as Set<number>)], [], 'unchanged: nothing');
    const repo = goodRepo();
    try {
      const file = 'ops/host/files/usr/local/sbin/zeroed-backup';
      onBase(repo, file, `#!/usr/bin/env bash\ncurl -s ${HOST}/api/coins\n`);
      assert.deepEqual(runChecks(repo.dir, 'main'), [], 'old line quiet');
      chmodSync(join(repo.dir, file), 0o755);
      repo.commit('mode change only');
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`), [`E_PUMP_FUN_HOST ${file}:2`], 'no hunk to read: the whole file is read');
      // A hunk that only removes lines is a parsable hunk with nothing added: the file is not read whole.
      chmodSync(join(repo.dir, file), 0o644);
      editText(repo.dir, file, (t) => t.replace('#!/usr/bin/env bash\n', ''));
      repo.commit('remove a line');
      assert.deepEqual(gitAt(repo.dir).addedLines('main').get(file)?.size, 0);
    } finally { repo.remove(); }
  });

  it('runs git diff with --text, so a NUL byte or attribute cannot turn a file\'s diff into "Binary files differ"', () => {
    const repo = goodRepo();
    try {
      const file = 'research/empirical/lib.mjs';
      onBase(repo, file, 'export const OLD = 1;\n');
      editText(repo.dir, file, (t) => `${t}// \0\nexport const NEW = 2;\n`);
      assert.deepEqual([...(gitAt(repo.dir).addedLines('main').get(file) ?? [])], [2, 3]);
      assert.deepEqual(gitAt(repo.dir).changedFiles('main'), [file]);
    } finally { repo.remove(); }
  });

  it('reads the lines a file gained from git diff -U0', () => {
    const diff = ['diff --git a b', '--- x', '+++ research/a.mjs', '@@ -2,0 +3,2 @@', '+++ an added line that starts with ++', '+b', '@@ -9 +11 @@', '-old', '+new',
      'diff --git c d', '--- y', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n');
    assert.deepEqual([...parseAddedLines(diff)].map(([f, l]) => `${f} ${[...l].join(',')}`), ['research/a.mjs 3,4,11']);
  });
});

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

  /** A git double: HEAD forked from `base`, whose lockfile text is `baseLock` (null: no merge base). */
  const auditGit = (baseLock: string | null): Git => ({
    listFiles: () => [], symlinks: () => [], submodules: () => [], hasRef: () => baseLock !== null, files: () => [], changedSince: () => [],
    show: (_ref, path) => (path === 'pnpm-lock.yaml' ? baseLock : null),
    blob: () => null,
    mergeBase: () => (baseLock === null ? null : 'merge-base'),
    addedLines: () => new Map(),
    changedFiles: () => [],
  });

  it('main: audits the checked projects\' packages only (Zeroed\'s with --include-zeroed), and fails closed', async () => {
    const repo = goodRepo();
    try {
      const lockPath = join(repo.dir, 'pnpm-lock.yaml');
      const base = readFileSync(lockPath, 'utf8');
      writeFileSync(lockPath, base.replace("  packages/types: {}\n", "  packages/types: {}\n\n  apps/web:\n    dependencies:\n      uuid:\n        specifier: 7.0.3\n        version: 7.0.3\n")
        .replace('\nsnapshots:\n', '\n  uuid@7.0.3:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  uuid@7.0.3: {}\n'));
      const bodies: string[] = [];
      const post: HttpPost = async (_url, body) => { bodies.push(body); return ok(JSON.parse(body).uuid ? { uuid: [{ severity: 'moderate', url: 'u', title: 't', vulnerable_versions: '<11.1.1' }] } : {}); };
      const io = capture();
      assert.equal(await auditMain([repo.dir], {}, io, post, pacing(), auditGit(base)), 0);
      assert.deepEqual(JSON.parse(bodies[0] as string), { '@solana/addresses': ['8.4.0'], '@solana/kit': ['8.4.0'], typescript: ['6.0.3'] });
      assert.match(io.text(), /no advisories of severity low or above for 3 package version\(s\)/);
      const io2 = capture();
      assert.equal(await auditMain(['--include-zeroed', repo.dir], {}, io2, post, pacing(), auditGit(base)), 1);
      assert.match(io2.text(), /E_AUDIT uuid: moderate advisory u: t \(vulnerable <11\.1\.1; installed 7\.0\.3\)/);
      const io3 = capture();
      assert.equal(await auditMain([repo.dir], {}, io3, async () => ok('', 404), pacing(), auditGit(base)), 1);
      assert.match(io3.text(), /E_AUDIT_FETCH registry: registry answered 404 for the advisory request; no further requests were made/);
      writeFileSync(lockPath, 'a: [\n');
      const io4 = capture();
      assert.equal(await auditMain([repo.dir], {}, io4, post, pacing(), auditGit(base)), 1);
      assert.match(io4.text(), /E_LOCK_PARSE/);
    } finally { repo.remove(); }
  });

  it('names the versions a change adds, and which findings they make blocking', () => {
    const payload = { uuid: ['7.0.3', '11.1.1'], left: ['1.0.0'] };
    assert.deepEqual([...addedVersions(payload, new Set(['uuid@7.0.3']))].sort(), ['left@1.0.0', 'uuid@11.1.1']);
    assert.deepEqual([...addedVersions(payload, new Set())].sort(), ['left@1.0.0', 'uuid@11.1.1', 'uuid@7.0.3']);
    const findings = [finding('E_AUDIT', 'uuid', 'moderate'), finding('E_AUDIT', 'left', 'high')];
    assert.deepEqual(blockingFindings(findings, payload, new Set(['left@1.0.0'])).map((f) => f.file), ['left']);
    assert.deepEqual(blockingFindings(findings, payload, new Set(['uuid@7.0.3'])).map((f) => f.file), ['uuid']);
    assert.deepEqual(blockingFindings(findings, payload, new Set()), []);
  });

  it('reads the run\'s mode from POLICY_EVENT: a pull request fails, every other run reports (supervisor ruling 1)', () => {
    assert.equal(reportOnly([], {}), false, 'a local run fails like a pull request\'s');
    assert.equal(reportOnly([], { POLICY_EVENT: 'pull_request' }), false);
    assert.equal(reportOnly([], { POLICY_EVENT: '' }), false);
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'pull_request_target']) assert.equal(reportOnly([], { POLICY_EVENT: event }), true, event);
    assert.equal(reportOnly(['--report-only'], { POLICY_EVENT: 'pull_request' }), true);
  });

  it('main: a push or scheduled run reports an advisory and exits 0; a pull request fails only on a version it adds (round 1 review F1, red team RT-02)', async () => {
    const repo = goodRepo();
    try {
      const lockPath = join(repo.dir, 'pnpm-lock.yaml');
      const base = readFileSync(lockPath, 'utf8');
      // typescript@6.0.3 is in the base lockfile: an advisory for it is not this change's doing.
      const advisory = { typescript: [{ severity: 'high', url: 'u', title: 't', vulnerable_versions: '<6.0.4' }] };
      const post: HttpPost = async () => ok(advisory);
      for (const event of ['push', 'schedule']) {
        const io = capture();
        assert.equal(await auditMain([repo.dir], { POLICY_EVENT: event }, io, post, pacing(), auditGit(base)), 0, event);
        assert.match(io.text(), /E_AUDIT typescript: high advisory u: t/, event);
        assert.match(io.text(), /reported only: this run is not a pull request's/, event);
      }
      const ioPr = capture();
      assert.equal(await auditMain([repo.dir], { POLICY_EVENT: 'pull_request' }, ioPr, post, pacing(), auditGit(base)), 0, 'a version already in use');
      assert.match(ioPr.text(), /E_AUDIT typescript: high advisory u: t/);
      assert.match(ioPr.text(), /1 advisory finding\(s\) in 3 package version\(s\), none for a version this change adds/);
      // The same advisory for a version the pull request adds fails the check.
      const ioAdds = capture();
      assert.equal(await auditMain([repo.dir], { POLICY_EVENT: 'pull_request' }, ioAdds, post, pacing(), auditGit(base.replace('typescript@6.0.3', 'typescript@6.0.2'))), 1);
      assert.match(ioAdds.text(), /1 of 1 advisory finding\(s\) are for package version\(s\) this change adds/);
      // A registry failure is this run's problem only on a pull request.
      const ioDown = capture();
      assert.equal(await auditMain([repo.dir], { POLICY_EVENT: 'push' }, ioDown, async () => ok('', 503), pacing(), auditGit(base)), 0);
      assert.match(ioDown.text(), /E_AUDIT_FETCH registry: registry answered 503 .*Reported only/s);
      assert.equal(await auditMain([repo.dir], { POLICY_EVENT: 'pull_request' }, capture(), async () => ok('', 503), pacing(), auditGit(base)), 1);
      // No merge base: the versions this change adds are unknown, so an advisory fails closed.
      const ioNoBase = capture();
      assert.equal(await auditMain([repo.dir], { POLICY_EVENT: 'pull_request' }, ioNoBase, post, pacing(), auditGit(null)), 1);
      assert.match(ioNoBase.text(), /E_BASE_REF origin\/ccr-14987baf-i6lrsl: no merge base/);
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
  it('skips the manifest\'s own files and Zeroed\'s workflows and jobs; every other path, new files included, is checked', () => {
    // The manifest is the Zeroed files of the integration branch at c045c18a (round 1 review F4, red team RT-01).
    const listed = readFileSync(join(REPO_ROOT, ZEROED_FILES_MANIFEST), 'utf8').split('\n').filter((l) => l !== '');
    assert.ok(listed.length > 2000, `the manifest holds Zeroed's files (${listed.length})`);
    assert.deepEqual([...listed].sort(), listed, 'sorted, so a diff of it reads');
    assert.equal(new Set(listed).size, listed.length, 'no duplicate');
    assert.ok(listed.every((f) => ZEROED_DIRS.some((d) => f.startsWith(d))), 'every entry is under a Zeroed folder');
    assert.ok(listed.every((f) => !f.endsWith('/') && !f.startsWith('/') && !f.includes('\\')), 'plain repository paths');
    for (const p of [ZEROED_FILE, 'apps/web/src/components/TokenActions.tsx', 'packages/core/src/amm/pump-curve.ts', 'research/empirical/backfill/meta.json',
      '.github/workflows/deploy.yml', 'apps/', 'apps/web/', 'packages/core/src/']) {
      assert.equal(inZeroed(p), true, p);
    }
    for (const p of ['apps/web/src/new-feed.ts', 'research/new/feed.ts', 'ops/recorder/feed.ts', 'apps/feed/package.json', 'apps/feed/', 'ops/recorder/',
      'packages/engine/src/a.ts', 'packages/types/src/a.ts', 'packages/corex/a.ts', 'tools/policy/a.ts', 'docs/blueprint/FACTS.json', 'docs/MIGRATION.md',
      '.github/workflows/ci.yml', '.github/workflows/guard.yml', '.github/workflows/new.yml', 'package.json', 'appsx/a.ts']) {
      assert.equal(inZeroed(p), false, p);
    }
    assert.equal(zeroedJob('.github/workflows/ci.yml', 'historical-data'), true);
    assert.equal(zeroedJob('.github/workflows/ci.yml', 'check'), false);
    assert.equal(zeroedJob('.github/workflows/guard.yml', 'historical-data'), false);
    assert.equal(scopeOf(false)(ZEROED_FILE), false);
    assert.equal(scopeOf(true)(ZEROED_FILE), true);
    assert.equal(scopeOf(false)('apps/web/src/new-feed.ts'), true, 'a new file under a Zeroed folder is checked');
    assert.equal(scopeOf(true).job('.github/workflows/ci.yml', 'historical-data'), true);
    assert.ok(ZEROED_DIRS.every((p) => p.endsWith('/')), 'directories only');
  });

  it('a new file under apps/, ops/ or research/ is checked: a pump.fun host and a banned import fail (red team RT-01)', () => {
    const repo = goodRepo();
    try {
      write(repo.dir, 'research/blueprint/feed.ts', `export const FEED = 'https://frontend-api.${HOST}/coins';\n`);
      write(repo.dir, 'ops/recorder/feed.ts', "import { Connection } from '@solana/web3.js';\n\nexport const c = Connection;\n");
      repo.commit('new files in Zeroed folders');
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_PUMP_FUN_HOST', 'E_UNDECLARED_IMPORT']);
      const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /E_PUMP_FUN_HOST research\/blueprint\/feed\.ts:1/);
      assert.match(r.stderr, /E_UNDECLARED_IMPORT ops\/recorder\/feed\.ts/);
    } finally { repo.remove(); }
  });

  it('a deliberately bad commit (a new apps/feed package) fails the check with E_NEW_PACKAGE_DIR (red team RT-01 test 2)', () => {
    const repo = goodRepo();
    try {
      write(repo.dir, 'pnpm-workspace.yaml', readFileSync(join(repo.dir, 'pnpm-workspace.yaml'), 'utf8').replace('  - packages/*\n', '  - packages/*\n  - apps/*\n'));
      write(repo.dir, 'apps/feed/package.json', `${JSON.stringify({ name: '@bot/feed', version: '0.0.0', dependencies: { '@solana/web3.js': '1.98.0' } }, null, 2)}\n`);
      repo.commit('a new workspace package under apps/');
      const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /E_NEW_PACKAGE_DIR apps\/feed\/package\.json: apps\/ hold Zeroed's packages/);
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_NEW_PACKAGE_DIR'], 'the package is refused before anyone installs it');
    } finally { repo.remove(); }
  });

  it('a new workspace package under apps/ is refused; Zeroed\'s own are not (red team RT-01 test 2)', () => {
    const s = goodSnapshot();
    const feed = { file: 'apps/feed/package.json', dir: 'apps/feed', json: { name: '@bot/feed', version: '0.0.0' } };
    assert.deepEqual(checkManifests(s), []);
    assert.deepEqual(checkManifests({ ...s, manifests: [...s.manifests, feed] }).map((f) => `${f.code} ${f.file}`), ['E_NEW_PACKAGE_DIR apps/feed/package.json']);
    const lock = structuredClone(s.lock) as PnpmLock;
    lock.importers['apps/feed'] = {};
    assert.deepEqual(codes(checkManifests({ ...s, lock })), ['E_NEW_PACKAGE_DIR'], 'a lockfile importer alone is enough');
    const web = { file: 'apps/web/package.json', dir: 'apps/web', json: { name: 'zeroed-app', version: '0.0.0' } };
    assert.deepEqual(checkManifests({ ...s, manifests: [...s.manifests, web] }), [], 'apps/web is on the Zeroed manifest');
    assert.deepEqual(checkManifests({ ...s, manifests: [...s.manifests, { ...feed, file: 'packages/feed/package.json', dir: 'packages/feed' }] }), [],
      'a new package under packages/ is checked by every check, so it is allowed');
  });

  it('a new symbolic link under a Zeroed folder is reported too; the manifest\'s own are skipped (red team RT-01)', () => {
    const repo = goodRepo();
    try {
      write(repo.dir, 'research/real.txt', 'x\n');
      symlinkSync('real.txt', join(repo.dir, 'research/link.txt'));
      symlinkSync('/dev/zero', join(repo.dir, 'research/endless'));            // read through, it would never end
      repo.commit('new links under research/');
      // Before the manifest (round 1 review F4) a new link here was skipped, and the checks stopped reading nothing.
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`), ['E_SYMLINK research/endless', 'E_SYMLINK research/link.txt']);
      assert.deepEqual(runChecks(repo.dir, 'main', { includeZeroed: true }).map((f) => `${f.code} ${f.file}`), ['E_SYMLINK research/endless', 'E_SYMLINK research/link.txt']);
      symlinkSync('../research/real.txt', join(repo.dir, 'packages/link.txt'));
      repo.commit('a link outside');
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`),
        ['E_SYMLINK packages/link.txt', 'E_SYMLINK research/endless', 'E_SYMLINK research/link.txt']);
      // This repository's own Zeroed links (research/historical/rpcscan) are on the manifest, so they stay skipped:
      // the test below runs the whole check over it.
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
