import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const isShell = (p: string) => p.endsWith('.sh') || read(p).startsWith('#!/usr/bin/env bash');
const shellScripts = [...walk('ops'), '.github/workflows/deploy.yml'].filter((p) => !p.endsWith('.mjs') && !p.endsWith('.md') && (p.endsWith('.yml') || isShell(p) || p.endsWith('/common.sh')));
const sourced = (p: string) => read(p).includes('Sourced, never run');

describe('installer', () => {
  it('is built from ops/host and its SHA-256 in the README is current', () => {
    expect(() => execFileSync('node', [join(root, 'ops/build-install.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('pins Node by version and SHA-256, and the GitHub merge key by fingerprint', () => {
    const main = read('ops/host/install-main.sh');
    expect(main).toMatch(/^NODE_VERSION=v22\.\d+\.\d+$/m);
    expect(main).toMatch(/^NODE_SHA256=[0-9a-f]{64}$/m);
    expect(main).toContain('sha256sum -c');
    const fpr = '968479A1AFF927E37D1A566BB5690EEEBB952194';
    expect(main).toContain(`WEB_FLOW_FPR=${fpr}`);
    const keys = execFileSync('gpg', ['--show-keys', '--with-colons', join(root, 'ops/host/files/etc/zeroed/github-web-flow.asc')], { encoding: 'utf8' });
    expect(keys.split('\n').filter((l) => l.startsWith('fpr:'))).toEqual([`fpr:::::::::${fpr}:`]);
  });
});

describe('secrets never leak', () => {
  it('no script turns on tracing', () => {
    const code = (p: string) => read(p).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const p of shellScripts) expect(code(p), p).not.toMatch(/set -[a-z]*x|set -o xtrace|bash -x/);
  });

  it('every shell script stops on errors and parses', () => {
    for (const p of shellScripts.filter((s) => !s.endsWith('.yml') && !sourced(s))) {
      expect(read(p), p).toContain('set -euo pipefail');
      expect(spawnSync('bash', ['-n', join(root, p)]).status, p).toBe(0);
    }
  });

  it('the bot token only reaches curl on stdin, never as an argument', () => {
    for (const p of shellScripts) {
      const s = read(p);
      expect(s, p).not.toMatch(/curl[^\n|]*bot\$/);
      if (s.includes('/bot%s/')) expect(s, p).toMatch(/\|\s*\n?\s*curl [^\n]*-K -/);
    }
  });

  it('credentials are encrypted from stdin and the plaintext bundle is never a file', () => {
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    expect(common).toContain('systemd-creds encrypt --with-key=host --name="$1" - "$CRED_DIR/$1.new"');
    const pair = read('ops/host/files/usr/local/sbin/zeroed-pair');
    expect(pair).toContain(`for k in "\${API_NAMES[@]}"; do printf '%s' "\${v[$k]}" | store_cred "\${k,,}"; done`);
    expect(pair).toContain('done < <(age -d -i <(/usr/local/bin/node /usr/local/lib/zeroed/derive-key.mjs < "$DEPLOY_CODE_FILE")');
    expect(pair).toMatch(/shred -u "\$DEPLOY_CODE_FILE"/);
    const publish = read('ops/deploy/publish.sh');
    expect(publish).toMatch(/\} \| age -r "\$recipient" -o "\$bundle"/);
    expect(publish).toContain('gh release create handoff "$bundle"');
  });

  it('the deploy workflow passes secrets and inputs only through env, uploads and caches nothing', () => {
    const wf = read('.github/workflows/deploy.yml');
    const runBlocks = wf.split('\n').reduce<string[]>((acc, line, i, all) => {
      if (/^\s+run: /.test(line)) {
        const indent = line.search(/\S/);
        const block = [line];
        for (let j = i + 1; j < all.length && (all[j]!.trim() === '' || all[j]!.search(/\S/) > indent); j++) block.push(all[j]!);
        acc.push(block.join('\n'));
      }
      return acc;
    }, []);
    expect(runBlocks.length).toBeGreaterThan(2);
    for (const b of runBlocks) expect(b).not.toMatch(/\$\{\{\s*(secrets|inputs|github\.event)\./);
    expect(wf).not.toMatch(/upload-artifact|actions\/cache|set-output|GITHUB_ENV|GITHUB_OUTPUT/);
    expect(wf).toContain('persist-credentials: false');
    for (const line of wf.split('\n').filter((l) => /\buses:/.test(l))) expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  const publish = (env: Record<string, string>) =>
    spawnSync('bash', [join(root, 'ops/deploy/publish.sh')], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', GH_REPO: 'o/r', GITHUB_SHA: 'a'.repeat(40), ISSUED: '1', ...env } });

  it('a missing secret is reported by name only', () => {
    const r = publish({ DEPLOY_CODE: 'abacus abdomen able about above absent', HELIUS_API_KEY: 'TESTvalueHelius123', ALCHEMY_API_KEY: 'TESTvalueAlchemy123' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Missing repository secrets: JUPITER_API_KEY TELEGRAM_BOT_TOKEN');
    expect(r.stdout + r.stderr).not.toMatch(/TESTvalue|abacus/);
  });

  it('without DEPLOY_CODE it sends nothing; a malformed code is refused without echoing it', () => {
    const none = publish({});
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('No DEPLOY_CODE secret: code update only');
    const keys = { HELIUS_API_KEY: 'TESTa', ALCHEMY_API_KEY: 'TESTb', JUPITER_API_KEY: 'TESTc', TELEGRAM_BOT_TOKEN: '1:TESTd' };
    const bad = publish({ DEPLOY_CODE: 'only three words', ...keys });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('DEPLOY_CODE must be the 6 words');
    expect(bad.stdout + bad.stderr).not.toMatch(/three words/);
  });
});

describe('deploy code', () => {
  const derive = (code: string) => spawnSync('node', [join(root, 'ops/host/files/usr/local/lib/zeroed/derive-key.mjs')], { input: code, encoding: 'utf8' });

  it('uses the EFF large wordlist, unchanged', () => {
    const words = read('ops/host/files/usr/local/share/zeroed/eff_large_wordlist.txt').trim().split('\n');
    expect(words).toHaveLength(7776);
    expect(new Set(words).size).toBe(7776);
    expect(createHash('sha256').update(read('ops/host/files/usr/local/share/zeroed/eff_large_wordlist.txt')).digest('hex')).toBe('6d557f0693958fb5e650b68b5bee585eb82cf4da32965505c789e924743bc522');
  });

  it('derives the same age identity on both sides, ignoring case and extra spaces, and only from 6 words', () => {
    const a = derive('abacus abdomen able about above absent');
    const b = derive('  Abacus   ABDOMEN able about above absent\n');
    expect(a.status).toBe(0);
    expect(a.stdout).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}\n$/);
    expect(b.stdout).toBe(a.stdout);
    expect(derive('abacus abdomen able about above absent zone').stdout).not.toBe(a.stdout);
    expect(derive('abacus abdomen able about above').status).toBe(2);
  }, 30_000);
});

describe('systemd units (ARCHITECTURE.md 12.1)', () => {
  const unit = (n: string) => read(`ops/host/files/etc/systemd/system/${n}`);
  const common = ['NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'RestrictNamespaces=yes', 'RestrictSUIDSGID=yes', 'LockPersonality=yes', 'SystemCallArchitectures=native', 'SystemCallFilter=@system-service', 'UMask=0077'];

  it('the signer has no network at all and W^X memory', () => {
    const s = unit('zeroed-signer.service');
    for (const k of [...common.filter((k) => k !== 'UMask=0077'), 'User=zeroed-signer', 'PrivateNetwork=yes', 'IPAddressDeny=any', 'RestrictAddressFamilies=AF_UNIX', 'MemoryDenyWriteExecute=yes']) expect(s, k).toMatch(new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    expect(s).toContain('node --jitless');
  });

  it('the worker is sandboxed, loads only encrypted credentials, and reconciles before every start', () => {
    const s = unit('zeroed-worker.service');
    for (const k of [...common, 'User=zeroed-worker', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6']) expect(s, k).toMatch(new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    expect(s).not.toMatch(/^LoadCredential=|^SetCredential=|^Environment=.*KEY/m);
    expect(s.match(/^LoadCredentialEncrypted=/gm)).toHaveLength(5);
    expect(s).toContain('ConditionPathExists=/etc/credstore.encrypted/telegram_chat_id');
    expect(s).toMatch(/^ExecStartPre=.* --reconcile$/m);
  });

  it('the firewall drops all inbound and limits the worker to HTTPS and DNS out', () => {
    const nft = read('ops/host/files/etc/nftables.conf');
    expect(nft).toContain('type filter hook input priority filter; policy drop;');
    expect(nft).toMatch(/^#SSH_RULE#/m);
    expect(nft).toContain('meta skuid "zeroed-signer" drop');
    expect(nft).toContain('meta skuid "zeroed-worker" drop');
  });
});
