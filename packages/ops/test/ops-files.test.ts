import { execFileSync, spawnSync } from 'node:child_process';
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
    const pair = read('ops/host/files/usr/local/sbin/zeroed-pair');
    expect(pair).toMatch(/printf '%s' "\$\{v\[\$k\]\}" \| systemd-creds encrypt --with-key=host --name="\$n" - /);
    expect(pair).toContain('done < <(age -d -i /etc/zeroed/age/host.key');
    const publish = read('ops/deploy/publish.sh');
    expect(publish).toMatch(/\} \| age -r "\$HOST_PUBLIC_KEY" -o "\$bundle"/);
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

  it('a missing secret is reported by name only', () => {
    const r = spawnSync('bash', [join(root, 'ops/deploy/publish.sh')], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        GH_REPO: 'o/r',
        GITHUB_SHA: 'a'.repeat(40),
        ISSUED: '1',
        HOST_PUBLIC_KEY: 'age1' + 'q'.repeat(58),
        PAIRING_CODE: 'ABCD-EFGH-JKLM',
        HELIUS_API_KEY: 'TESTvalueHelius123',
        ALCHEMY_API_KEY: 'TESTvalueAlchemy123',
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Missing repository secrets: JUPITER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID');
    expect(r.stdout + r.stderr).not.toMatch(/TESTvalue/);
  });

  it('refuses malformed host keys and pairing codes before touching any secret', () => {
    const run = (env: Record<string, string>) => spawnSync('bash', [join(root, 'ops/deploy/publish.sh')], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', GH_REPO: 'o/r', GITHUB_SHA: 'a', ISSUED: '1', ...env } });
    expect(run({ HOST_PUBLIC_KEY: 'ssh-ed25519 AAAA', PAIRING_CODE: 'ABCD-EFGH-JKLM' }).stderr).toContain('Host public key');
    expect(run({ HOST_PUBLIC_KEY: 'age1' + 'q'.repeat(58), PAIRING_CODE: 'abcd' }).stderr).toContain('Pairing code');
  });
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
    expect(s.match(/^LoadCredentialEncrypted=/gm)).toHaveLength(6);
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
