import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wf = readFileSync(fileURLToPath(new URL('../../../.github/workflows/android-preview.yml', import.meta.url)), 'utf8');
const releaseJob = wf.slice(wf.indexOf('\n  release:'));

describe('android-preview workflow', () => {
  it('touches the release only from the integration branch, never from a pull request', () => {
    const cond = releaseJob.match(/\n    if: (.*)\n/)?.[1] ?? '';
    expect(cond).toContain("github.ref == 'refs/heads/ccr-14987baf-i6lrsl'");
    expect(cond).toMatch(/event_name == 'push'/);
    expect(cond).toMatch(/event_name == 'workflow_dispatch'/);
    expect(cond).not.toContain('pull_request');
  });

  it('gives write access to the release job only', () => {
    expect(wf.slice(0, wf.indexOf('\njobs:'))).not.toContain('contents: write');
    expect(releaseJob).toContain('contents: write');
    expect(wf.slice(0, wf.indexOf('\n  release:'))).not.toMatch(/gh release|contents: write/);
  });

  it('replaces the single asset without a window where the link is dead', () => {
    const script = readFileSync(fileURLToPath(new URL('../../../.github/scripts/publish-preview.sh', import.meta.url)), 'utf8');
    expect(releaseJob).toContain('bash .github/scripts/publish-preview.sh');
    // Never --clobber (it deletes the old asset before the upload): upload under a temporary name, then swap.
    expect(script).not.toMatch(/--clobber/);
    expect(script).toContain('gh release upload preview "$NEXT"');
  });

  it('publishes only after CI check passed on the exact commit (OPS-GATE)', () => {
    const require = releaseJob.indexOf('run: bash .github/scripts/require-check.sh');
    expect(require).toBeGreaterThan(0);
    expect(require).toBeLessThan(releaseJob.indexOf('run: bash .github/scripts/publish-preview.sh'));
    expect(releaseJob).toContain('checks: read');
    const script = fileURLToPath(new URL('../../../.github/scripts/require-check.sh', import.meta.url));
    // A gh stand-in serving each call the next listing from a queue; the script must ask about GITHUB_SHA only.
    // WAIT_S 1 makes a pending check time out at once; bash's SECONDS ticks on whole wall-clock seconds, so a 1 s
    // deadline can pass after a few ms. Runs that must reach a later answer get a long one (they end on that answer).
    const run = (listings: object[], wait = '1') => {
      const dir = mkdtempSync(join(tmpdir(), 'zeroed-require-'));
      listings.forEach((l, i) => writeFileSync(join(dir, `l${i}`), JSON.stringify(l)));
      writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/calls"\nn=$(wc -l < "${dir}/calls"); cat "${dir}/l$((n - 1))" 2>/dev/null || cat "${dir}/l${listings.length - 1}"\n`);
      chmodSync(join(dir, 'gh'), 0o755);
      const r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env['PATH']}`, GH_REPO: 'o/r', GITHUB_SHA: 'a'.repeat(40), WAIT_S: wait, POLL_S: '0.2' } });
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      rmSync(dir, { recursive: true, force: true });
      return { status: r.status, out: r.stdout, calls };
    };
    const runs = (...r: object[]) => ({ total_count: r.length, check_runs: r });
    const gha = { slug: 'github-actions' };
    const ok = run([runs(), runs({ name: 'check', status: 'in_progress', conclusion: null, app: gha }), runs({ name: 'check', status: 'completed', conclusion: 'success', app: gha })], '60');
    expect(ok.status, ok.out).toBe(0);
    expect(ok.calls).toContain(`repos/o/r/commits/${'a'.repeat(40)}/check-runs`);
    for (const bad of [
      runs({ name: 'check', status: 'completed', conclusion: 'failure', app: gha }),
      runs({ name: 'check', status: 'completed', conclusion: 'skipped', app: gha }),
      runs({ name: 'check', status: 'completed', conclusion: 'success', app: { slug: 'some-bot' } }),
      runs({ name: 'build', status: 'completed', conclusion: 'success', app: gha }),
      runs({ name: 'check', status: 'in_progress', conclusion: null, app: gha }),
      runs(),
    ]) expect(run([bad]).status).toBe(1);
    // A re-run counts: the newest run of check decides.
    expect(run([runs({ name: 'check', status: 'completed', conclusion: 'failure', started_at: '2026-10-04T01:00:00Z', app: gha }, { name: 'check', status: 'completed', conclusion: 'success', started_at: '2026-10-04T02:00:00Z', app: gha })]).status).toBe(0);
  });

  it('checks the Gradle distribution against its published SHA-256 before running it (SEC-1)', () => {
    const props = readFileSync(fileURLToPath(new URL('../android/gradle/wrapper/gradle-wrapper.properties', import.meta.url)), 'utf8');
    // gradle-8.14.3-all.zip, from services.gradle.org's .sha256 file and gradle.org/release-checksums.
    expect(props).toContain('distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip');
    expect(props.split('\n')).toContain('distributionSha256Sum=ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c');
  });

  it('commits no keystore', () => {
    expect(readFileSync(fileURLToPath(new URL('../../../.gitignore', import.meta.url)), 'utf8')).toMatch(/\*\.keystore/);
  });

  it('signs pull requests and other branches with a throwaway key, and only the integration branch with a stable one (SEC-1)', () => {
    const step = (name: string) => wf.slice(wf.indexOf(`name: ${name}`), wf.indexOf('\n      - ', wf.indexOf(`name: ${name}`)));
    const signing = step('Signing key');
    expect(signing).toContain("INTEGRATION: ${{ github.ref == 'refs/heads/ccr-14987baf-i6lrsl' && github.event_name != 'pull_request' }}");
    expect(signing).toContain('KEYSTORE_B64: ${{ secrets.PREVIEW_KEYSTORE_B64 }}');
    expect(signing).toContain('CERT_SHA256: ${{ vars.PREVIEW_CERT_SHA256 }}');
    expect(signing).toContain('run: bash .github/scripts/preview-signing.sh');
    // The cache any pull-request workflow can restore is never even restored by one here.
    expect(step('Restore debug keystore')).toContain("if: steps.signing.outputs.source == 'cache'");
    expect(step('Create debug keystore')).toContain("if: steps.signing.outputs.source == 'throwaway' || (steps.signing.outputs.source == 'cache' && steps.keystore.outputs.cache-hit != 'true')");
    expect(step('Build debug APK')).toContain("ZEROED_KEYSTORE_PASSWORD: ${{ steps.signing.outputs.source == 'secret' && secrets.PREVIEW_KEYSTORE_PASSWORD || '' }}");
    // Secrets appear only in those two steps.
    expect(wf.match(/secrets\.PREVIEW_/g)).toHaveLength(3);
    expect(step('Verify the APK')).toContain('bash .github/scripts/verify-preview-cert.sh "$apk"');
    const check = releaseJob.indexOf('run: bash .github/scripts/verify-preview-cert.sh zeroed-preview.apk');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(releaseJob.indexOf('run: bash .github/scripts/publish-preview.sh'));
    // CI's check first, then the certificate, then publish.
    expect(releaseJob.indexOf('run: bash .github/scripts/require-check.sh')).toBeGreaterThan(0);
    expect(releaseJob.indexOf('run: bash .github/scripts/require-check.sh')).toBeLessThan(check);
    expect(releaseJob).toContain('CERT_SHA256: ${{ vars.PREVIEW_CERT_SHA256 }}');
    const gradle = readFileSync(fileURLToPath(new URL('../android/app/build.gradle', import.meta.url)), 'utf8');
    expect(gradle).toContain("System.getenv('ZEROED_KEYSTORE_PASSWORD') ?: 'android'");
    expect(gradle).toContain("System.getenv('ZEROED_KEY_ALIAS') ?: 'androiddebugkey'");
    const ignore = readFileSync(fileURLToPath(new URL('../../../.gitignore', import.meta.url)), 'utf8');
    for (const g of ['*.keystore', '*.jks', '*.p12', '*.b64']) expect(ignore.split('\n')).toContain(g);
  });

  const script = (name: string) => fileURLToPath(new URL(`../../../.github/scripts/${name}`, import.meta.url));
  const temp = () => mkdtempSync(join(tmpdir(), 'zeroed-sign-'));
  // A PKCS12 keystore like the owner's (alias zeroed-preview), made with OpenSSL; returns it in base64 and its fingerprint.
  const keystore = (dir: string, password: string) => {
    const sh = (cmd: string) => execFileSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' }).trim();
    sh("openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -subj '/CN=Zeroed preview' -days 2 2>/dev/null");
    sh(`openssl pkcs12 -export -inkey k.pem -in c.pem -name zeroed-preview -passout pass:${password} -out ks.p12`);
    return { b64: readFileSync(join(dir, 'ks.p12')).toString('base64'), fpr: sh('openssl x509 -in c.pem -noout -fingerprint -sha256').replace(/^.*=/, '') };
  };
  const signing = (env: Record<string, string>) => {
    const dir = temp();
    writeFileSync(join(dir, 'out'), '');
    writeFileSync(join(dir, 'env'), '');
    const r = spawnSync('bash', [script('preview-signing.sh')], { encoding: 'utf8', env: { PATH: process.env['PATH'], HOME: dir, GITHUB_OUTPUT: join(dir, 'out'), GITHUB_ENV: join(dir, 'env'), ...env } });
    const res = { status: r.status, log: r.stdout + r.stderr, out: readFileSync(join(dir, 'out'), 'utf8'), env: readFileSync(join(dir, 'env'), 'utf8'), home: dir };
    return res;
  };

  it('preview-signing.sh: uses the secret only on the integration branch and only when its certificate matches the pinned one', () => {
    const k = temp();
    const pw = 'correct-horse-battery';
    const { b64, fpr } = keystore(k, pw);
    const secret = { KEYSTORE_B64: b64, KEYSTORE_PASSWORD: pw, CERT_SHA256: fpr };
    const runs: ReturnType<typeof signing>[] = [];
    const run = (env: Record<string, string>) => {
      const r = signing(env);
      runs.push(r);
      return r;
    };
    try {
      // A pull request gets a throwaway key even when the secret is present (same-repo pull requests receive secrets).
      const pr = run({ INTEGRATION: 'false', ...secret });
      expect([pr.status, pr.out]).toEqual([0, 'source=throwaway\n']);
      expect(pr.env).toBe('');
      const before = run({ INTEGRATION: 'true' });
      expect([before.status, before.out]).toEqual([0, 'source=cache\n']);
      expect(before.log).toContain('::warning::');
      const ok = run({ INTEGRATION: 'true', ...secret, CERT_SHA256: fpr.toLowerCase() });
      expect([ok.status, ok.out], ok.log).toEqual([0, 'source=secret\n']);
      expect(ok.env).toBe(`ZEROED_DEBUG_KEYSTORE=${join(ok.home, '.zeroed-preview/preview.p12')}\nZEROED_KEY_ALIAS=zeroed-preview\n`);
      expect(readFileSync(join(ok.home, '.zeroed-preview/preview.p12')).toString('base64')).toBe(b64);
      // Refused, signing nothing: another key, a wrong password, a missing password, a bad pin, a pin without the secret.
      const other = keystore(temp(), pw).fpr;
      for (const env of [
        { ...secret, CERT_SHA256: other },
        { ...secret, KEYSTORE_PASSWORD: 'wrong-password' },
        { KEYSTORE_B64: b64, CERT_SHA256: fpr },
        { ...secret, CERT_SHA256: 'AB:CD' },
        { ...secret, KEYSTORE_B64: '%%%not-base64%%%' },
        { CERT_SHA256: fpr },
      ]) {
        const bad = run({ INTEGRATION: 'true', ...env });
        expect(bad.status, JSON.stringify(Object.keys(env))).toBe(1);
        expect(bad.out).toBe('');
        expect(bad.env).toBe('');
        expect(bad.log).toContain('::error::');
      }
      // Never prints the password or the keystore.
      for (const r of runs) {
        expect(r.log).not.toContain(pw);
        expect(r.log).not.toContain(b64.slice(0, 40));
      }
    } finally {
      for (const d of [k, ...runs.map((r) => r.home)]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('verify-preview-cert.sh: passes only an APK with one signer whose certificate is the pinned one', () => {
    const dir = temp();
    const fpr = 'ab'.repeat(32);
    const apksigner = (out: string, code = 0) => {
      writeFileSync(join(dir, 'apksigner'), `#!/usr/bin/env bash\ncat <<'X'\n${out}\nX\nexit ${code}\n`);
      chmodSync(join(dir, 'apksigner'), 0o755);
    };
    const run = (pin: string) => spawnSync('bash', [script('verify-preview-cert.sh'), 'app.apk'], { encoding: 'utf8', env: { PATH: process.env['PATH'], APKSIGNER: join(dir, 'apksigner'), CERT_SHA256: pin } });
    const signer = (n: number, d: string) => `Signer #${n} certificate DN: CN=Zeroed preview\nSigner #${n} certificate SHA-256 digest: ${d}\nSigner #${n} certificate SHA-1 digest: 00`;
    try {
      apksigner(signer(1, fpr));
      expect(run(fpr.toUpperCase().match(/../g)!.join(':')).status).toBe(0);
      const unset = run('');
      expect([unset.status, unset.stdout.includes('::warning::')]).toEqual([0, true]);
      expect(run('cd'.repeat(32)).status).toBe(1);
      apksigner(`${signer(1, fpr)}\n${signer(2, 'cd'.repeat(32))}`);
      expect(run(fpr).status).toBe(1);
      apksigner('', 0);
      expect(run(fpr).status).toBe(1);
      apksigner(signer(1, fpr), 1);
      expect(run(fpr).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('workflow supply chain', () => {
  const dir = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
  it('pins every third-party action to a full commit SHA, with the tag in a comment', () => {
    const uses = readdirSync(dir)
      .filter((f) => f.endsWith('.yml'))
      .flatMap((f) => readFileSync(dir + f, 'utf8').split('\n').filter((l) => /\buses:/.test(l)).map((l) => `${f}: ${l.trim()}`));
    expect(uses.length).toBeGreaterThan(8);
    for (const line of uses) expect(line, line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});

describe('android app data', () => {
  const res = fileURLToPath(new URL('../android/app/src/main/', import.meta.url));
  it('turns off backup and device transfer for all app data', () => {
    const manifest = readFileSync(res + 'AndroidManifest.xml', 'utf8');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:fullBackupContent="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    const rules = readFileSync(res + 'res/xml/data_extraction_rules.xml', 'utf8');
    for (const section of ['cloud-backup', 'device-transfer']) {
      const body = rules.slice(rules.indexOf(`<${section}>`), rules.indexOf(`</${section}>`));
      for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
        expect(body).toContain(`<exclude domain="${domain}" path="." />`);
      }
    }
  });
});
