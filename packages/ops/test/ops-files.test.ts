import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.name !== 'node_modules').flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const isShell = (p: string) => p.endsWith('.sh') || read(p).startsWith('#!/usr/bin/env bash');
const shellScripts = [...walk('ops'), '.github/workflows/deploy.yml'].filter((p) => !p.endsWith('.mjs') && !p.endsWith('.md') && (p.endsWith('.yml') || isShell(p) || p.endsWith('/common.sh')));
const sourced = (p: string) => read(p).includes('Sourced, never run');

describe('installer', () => {
  it('is built from ops/host and its SHA-256 in the README is current', () => {
    expect(() => execFileSync('node', [join(root, 'ops/build-install.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });

  it('carries every host file byte for byte', () => {
    const script = read('ops/install.sh');
    const files = walk('ops/host/files');
    const blocks = [...script.matchAll(/^install_file (\S+) (0755|0644) <<'__ZEROED_FILE__'\n([\s\S]*?)^__ZEROED_FILE__$/gm)];
    expect(blocks.map((b) => b[1]).sort()).toEqual(files.map((f) => f.slice('ops/host/files'.length)).sort());
    for (const b of blocks) expect(b[3], b[1]).toBe(read(join('ops/host/files', b[1]!)));
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

  // Known answer from ops/test/derive-key-kat.py (Python hashlib.scrypt, its own bech32 and RFC 7748 ladder).
  const KAT_CODE = 'correct horse battery staple zebra apple';
  const KAT_IDENTITY = 'AGE-SECRET-KEY-1WZ76MN6D25Z7YG7GGHLLDMJCQV25X8U3VS8A0F8CKDS4329KJ39S5JU9UT';
  const KAT_RECIPIENT = 'age1pdc533pjcgkux8lah569p90yxvmx8djw42pycdt6k943e467tqcs4c4hf0';
  const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const bech32Polymod = (v: number[]) => {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let c = 1;
    for (const x of v) {
      const t = c >>> 25;
      c = ((c & 0x1ffffff) << 5) ^ x;
      for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]!;
    }
    return c >>> 0;
  };
  const bech32 = (hrp: string, data: Uint8Array) => {
    const d: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const b of data) {
      acc = ((acc << 8) | b) & 0xffff;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        d.push((acc >>> bits) & 31);
      }
    }
    if (bits) d.push((acc << (5 - bits)) & 31);
    const e = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
    const m = bech32Polymod([...e, ...d, 0, 0, 0, 0, 0, 0]) ^ 1;
    return `${hrp}1${[...d, ...[0, 1, 2, 3, 4, 5].map((i) => (m >>> (5 * (5 - i))) & 31)].map((x) => B32[x]).join('')}`;
  };
  const unbech32 = (s: string) => {
    const words = [...s.toLowerCase().slice(s.lastIndexOf('1') + 1, -6)].map((c) => B32.indexOf(c));
    const out: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const w of words) {
      acc = ((acc << 5) | w) & 0xffff;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >>> bits) & 255);
      }
    }
    return Uint8Array.from(out);
  };

  it('matches the independent known-answer vector, and its recipient is the X25519 public key of the clamped scalar', () => {
    const r = derive(KAT_CODE);
    expect(r.stdout.trim()).toBe(KAT_IDENTITY);
    const scalar = unbech32(KAT_IDENTITY);
    expect(scalar).toHaveLength(32);
    expect(scalar[0]! & 7).toBe(0);
    expect(scalar[31]! & 0xc0).toBe(0x40);
    // Node's X25519 (not age, not our code) computes the public key; it must be the pinned recipient.
    const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(scalar)]), format: 'der', type: 'pkcs8' });
    const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
    expect(bech32('age', pub)).toBe(KAT_RECIPIENT);
    expect(bech32('age-secret-key-', scalar).toUpperCase()).toBe(KAT_IDENTITY);
  }, 30_000);

  it('is one implementation, called by both the workflow and the server', () => {
    expect(read('ops/deploy/publish.sh')).toContain('node "$here/../host/files/usr/local/lib/zeroed/derive-key.mjs"');
    expect(read('ops/host/files/usr/local/sbin/zeroed-pair')).toContain('/usr/local/bin/node /usr/local/lib/zeroed/derive-key.mjs < "$DEPLOY_CODE_FILE"');
    expect(walk('ops').filter((p) => /scryptSync|hashlib\.scrypt|crypto\.scrypt/.test(read(p)) && !p.endsWith('.py')).sort()).toEqual(['ops/host/files/usr/local/lib/zeroed/derive-key.mjs', 'ops/install.sh']);
  });

  it('ignores case and extra spaces, and takes exactly 6 words', () => {
    // One scrypt run here (each is 256 MB and about a second): the normalised form must give the known answer.
    const b = derive('  Correct   HORSE battery staple zebra apple\n');
    expect(b.status).toBe(0);
    expect(b.stdout.trim()).toBe(KAT_IDENTITY);
    expect(derive('correct horse battery staple zebra apple extra').status).toBe(2);
    expect(derive('correct horse battery staple zebra').status).toBe(2);
  }, 30_000);
});

describe('off-server backup gate', () => {
  it('ships off: the flag is false, the installer does not enable the timer, and the sender checks the flag first', () => {
    expect(JSON.parse(read('ops/host-config.json'))).toEqual({
      offsite_backup: false, worker: 'stub', // PAUSE (owner, 2026-10-07): back to 'release' when every blocker is fixed
      // RECORD-UPLOAD: on by the owner's decision (6 Oct about 12:30 AM: "Approve upload", "Okay yes delete after upload").
      record_upload: true, record_upload_delete_local: true,
      // PRACTICE-ON: the S0 shakedown (packages/worker/test/practice-on.test.ts checks each value).
      shakedown: {
        ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'on', ZEROED_PAPER_EDGE_PPM: '178092',
        ZEROED_STANDINS: 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', ZEROED_WALLET: 'FdmNGWTvFJfkioV6jPg6HCC1ng3T5vGo4fBKAgX3vTTf',
      },
    });
    expect(read('ops/host/install-main.sh')).not.toMatch(/enable[^\n]*zeroed-backup-offsite/);
    const send = read('ops/host/files/usr/local/sbin/zeroed-backup-offsite');
    expect(send.indexOf("jq -r '.offsite_backup == true'")).toBeGreaterThan(0);
    expect(send.indexOf("jq -r '.offsite_backup == true'")).toBeLessThan(send.indexOf('sendDocument'));
    expect(send).toContain('age -d -i /etc/zeroed/age/host.key "$newest" | age -r "$owner" -o "$copy"');
  });
});

describe('heartbeat signers', () => {
  it('sign timestamp, method, path and body, like the watchdog verifies', () => {
    expect(read('ops/host/files/opt/zeroed/stub/worker.mjs')).toContain('.update(`${t}\\nPOST\\n/heartbeat\\n${body}`)');
    expect(read('ops/host/files/usr/local/sbin/zeroed-resume')).toContain('.update(`${t}\\nPOST\\n/resume\\n${body}`)');
  });
});

describe('watchdog tooling', () => {
  it('pins wrangler exactly, locks every package with an integrity hash, and installs without scripts', () => {
    const pkg = JSON.parse(read('ops/watchdog/deploy/package.json')) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies).toEqual({ wrangler: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    const lock = JSON.parse(read('ops/watchdog/deploy/package-lock.json')) as { packages: Record<string, { version?: string; integrity?: string; resolved?: string; link?: boolean }> };
    expect(lock.packages['node_modules/wrangler']?.version).toBe(pkg.devDependencies['wrangler']);
    for (const [name, p] of Object.entries(lock.packages)) {
      if (name === '' || p.link) continue;
      expect(p.integrity, name).toMatch(/^sha512-/);
      expect(p.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
    const wf = read('.github/workflows/deploy.yml');
    expect(wf).toContain('run: npm ci --ignore-scripts --no-audit --no-fund');
    expect(wf).not.toMatch(/npx|npm install/);
    expect(read('pnpm-workspace.yaml')).not.toMatch(/ops/);
  });

  it('runs on the free plan only', () => {
    const toml = read('packages/ops/wrangler.toml');
    expect(toml).toContain('workers_dev = true');
    expect(toml).toContain('new_sqlite_classes = ["Watchdog"]');
    expect(toml).not.toMatch(/^routes?\s*=|custom_domain|usage_model|\[\[kv_namespaces\]\]|\[\[r2_buckets\]\]/m);
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
    expect(s.match(/^LoadCredentialEncrypted=/gm)).toHaveLength(5);
    expect(s).toContain('ConditionPathExists=/etc/credstore.encrypted/telegram_chat_id');
    expect(s).toMatch(/^ExecStartPre=.* --reconcile$/m);
  });

  it('the recording upload runs as the worker user with no capability, the recorder its only writable data path, low priority and bounded', () => {
    const s = unit('zeroed-record-upload@.service');
    const has = (k: string) => expect(s, k).toMatch(new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    for (const k of [...common, 'User=zeroed-worker', 'Group=zeroed-worker', 'AmbientCapabilities=', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'ProtectProc=invisible', 'Nice=19', 'IOSchedulingClass=idle', 'CPUQuota=25%', 'MemoryMax=96M', 'TimeoutStartSec=12h', 'Type=oneshot']) has(k);
    // Pinned exactly, so none of these can widen without this test changing: who it runs as, what it may hold and write.
    const pinned = s.split('\n').filter((l) => /^(User|Group|SupplementaryGroups|DynamicUser|CapabilityBoundingSet|AmbientCapabilities|ReadWritePaths|ReadOnlyPaths|BindPaths|BindReadOnlyPaths|TemporaryFileSystem|InaccessiblePaths|InaccessibleDirectories|ReadWriteDirectories|StateDirectory|LoadCredential|LoadCredentialEncrypted|SetCredential|ImportCredential|ExecStart|ExecStartPre|ExecStartPost|PermissionsStartOnly)=/.test(l));
    expect(pinned).toEqual([
      'User=zeroed-worker', 'Group=zeroed-worker',
      'ExecStart=/usr/bin/flock /var/lib/zeroed-record-upload/run.lock /usr/local/bin/node --max-old-space-size=48 /usr/local/lib/zeroed/record-upload.mjs --scope %i',
      'ImportCredential=heartbeat_hmac_key', 'ImportCredential=helius_api_key', 'ImportCredential=alchemy_api_key', 'ImportCredential=jupiter_api_key',
      'ImportCredential=telegram_bot_token', 'ImportCredential=telegram_chat_id',
      'StateDirectory=zeroed-record-upload',
      // The ledger and the worker's other state unreachable; the signer's folders too (the user is in its group).
      'TemporaryFileSystem=/var/lib/zeroed:ro', 'BindPaths=/var/lib/zeroed/recorder', 'BindReadOnlyPaths=-/var/lib/zeroed/journal.jsonl',
      'InaccessiblePaths=-/run/zeroed-signer -/var/lib/zeroed-signer',
      'CapabilityBoundingSet=', 'AmbientCapabilities=',
    ]);
    // The only paths the uploader reads in the worker's state are the two bound in.
    expect(read('ops/host/files/usr/local/lib/zeroed/record-upload.mjs')).toContain("root: '/var/lib/zeroed/recorder',\n  journal: '/var/lib/zeroed/journal.jsonl',");
    // The credentials it imports are the ones the worker already holds, and the ones it scans recordings for.
    const worker = unit('zeroed-worker.service');
    for (const n of ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token', 'telegram_chat_id']) expect(worker).toContain(`LoadCredentialEncrypted=${n}:`);
    expect(worker).toContain('ImportCredential=heartbeat_hmac_key');
    expect(read('ops/host/files/usr/local/lib/zeroed/record-upload.mjs')).toContain("export const CREDENTIALS = ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token', 'telegram_chat_id', 'heartbeat_hmac_key'];");
    // RemoveIPC would remove the running worker's IPC objects (same user) when a run ends.
    expect(s).not.toMatch(/^RemoveIPC=/m);
  });

  it('the recording upload timer runs 10 minutes after boot or switch-on, then an hour after each run, and only the host-config switch turns it on', () => {
    const t = unit('zeroed-record-upload.timer');
    for (const k of ['OnBootSec=10min', 'OnActiveSec=10min', 'OnUnitInactiveSec=1h', 'Unit=zeroed-record-upload@all.service']) expect(t).toMatch(new RegExp(`^${k}$`, 'm'));
    expect(read('ops/host/install-main.sh')).not.toMatch(/enable[^\n]*zeroed-record-upload/);
    const upd = read('ops/host/files/usr/local/sbin/zeroed-update');
    expect(upd).toContain(`if [ "$(jq -r '.record_upload == true' /opt/zeroed/current/ops/host-config.json 2>/dev/null || echo false)" = true ]; then\n  systemctl enable --now zeroed-record-upload.timer`);
    expect(upd).toContain('  systemctl disable --now zeroed-record-upload.timer >/dev/null 2>&1 || true');
    // The uploader reads the switch itself before anything else, and a missing or invalid delete switch is off.
    const mjs = read('ops/host/files/usr/local/lib/zeroed/record-upload.mjs');
    const main = mjs.slice(mjs.indexOf('const main = async'));
    expect(main.indexOf('if (hc.record_upload !== true)')).toBeGreaterThan(0);
    expect(main.indexOf('if (hc.record_upload !== true)')).toBeLessThan(main.indexOf('new Uploader('));
    expect(main).toContain('deleteLocal: hc.record_upload_delete_local === true');
  });

  it('curl gets its URL, headers and file on stdin (-K -), at 2 MB/s, without "Expect: 100-continue"', () => {
    const mjs = read('ops/host/files/usr/local/lib/zeroed/record-upload.mjs');
    expect(mjs).toContain("spawn(curl, ['-K', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })");
    for (const k of ["'header = \"expect:\"'", "'limit-rate = 2M'", "`upload-file = ${quote(path)}`", "`header = ${quote(`x-zeroed-signature: ${h.signature}`)}`"]) expect(mjs, k).toContain(k);
  });

  it('the firewall drops all inbound and limits the worker to HTTPS and DNS out', () => {
    const nft = read('ops/host/files/etc/nftables.conf');
    expect(nft).toContain('type filter hook input priority filter; policy drop;');
    expect(nft).toMatch(/^#SSH_RULE#/m);
    expect(nft).toContain('meta skuid "zeroed-signer" drop');
    expect(nft).toContain('meta skuid "zeroed-worker" drop');
  });
});

describe('deploy tag (ops/deploy/tag.sh) on a fixture repository', () => {
  type Run = { name: string; status?: string; conclusion?: string | null; app?: string };
  // A fixture repository of GitHub-signed (or unsigned) commits and a gh stand-in serving each commit's check runs.
  const fixture = (build: (commit: (msg: string, signed: boolean, file?: string) => string) => { tip: string; checks: Record<string, Run[]> }) => {
    const dir = mkdtempSync(join(tmpdir(), 'zeroed-tag-'));
    const gnupg = join(dir, 'gnupg');
    mkdirSync(gnupg, { mode: 0o700 });
    const env = { ...process.env, GNUPGHOME: gnupg, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    const sh = (cmd: string, cwd = dir) => execFileSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8' }).trim();
    sh("gpg --batch --passphrase '' --quick-gen-key 'Fixture <f@x>' ed25519 sign never 2>/dev/null");
    const fpr = sh("gpg --batch --with-colons --fingerprint | awk -F: '$1 == \"fpr\" { print $10; exit }'");
    sh(`gpg --batch --armor --export ${fpr} > key.asc`);
    sh('git init -q --bare origin.git && git init -q -b int work');
    const work = join(dir, 'work');
    const commit = (msg: string, signed: boolean, file = 'f') => {
      sh(`mkdir -p $(dirname ${file}) && echo ${msg} >> ${file} && git add ${file} && git -c gpg.format=openpgp -c gpg.program=gpg -c user.signingkey=${fpr} commit -q ${signed ? '-S' : '--no-gpg-sign'} -m ${msg}`, work);
      return sh('git rev-parse HEAD', work);
    };
    const { tip, checks } = build(commit);
    sh('git remote add origin ../origin.git && git push -q origin int', work);
    const state = join(dir, 'state');
    mkdirSync(join(state, 'checks'), { recursive: true });
    for (const [sha, runs] of Object.entries(checks)) {
      // A running Deploy job is always listed: it never counts.
      const all = [...runs, { name: 'zeroed-deploy', status: 'in_progress', conclusion: null }];
      writeFileSync(join(state, 'checks', sha), JSON.stringify({ total_count: all.length, check_runs: all.map((r) => ({ status: 'completed', ...r, app: { slug: r.app ?? 'github-actions' } })) }));
    }
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env bash
echo "$*" >> "${state}/calls"
case "$2" in
  repos/o/r/commits/*/check-runs*) s="\${2#repos/o/r/commits/}"; s="\${s%%/*}"; cat "${state}/checks/$s" 2>/dev/null || echo '{"total_count":0,"check_runs":[]}' ;;
  repos/o/r/git/ref/tags/deploy) echo '{"message":"Not Found"}'; exit 1 ;;
esac
exit 0
`,
    );
    chmodSync(join(dir, 'gh'), 0o755);
    const r = spawnSync('bash', [join(root, 'ops/deploy/tag.sh')], {
      cwd: work,
      encoding: 'utf8',
      env: { ...env, PATH: `${dir}:${process.env['PATH']}`, GH_REPO: 'o/r', GITHUB_SHA: tip, INTEGRATION_BRANCH: 'int', SIGNING_KEY_FILE: join(dir, 'key.asc'), SIGNING_FPR: fpr },
    });
    const calls = existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8') : '';
    rmSync(dir, { recursive: true, force: true });
    return { ...r, calls };
  };
  const ok: Run[] = [{ name: 'check', conclusion: 'success' }, { name: 'e2e', conclusion: 'success' }];

  it('skips an unsigned tip, a red and a pending signed merge, logs why, and tags the newest green signed merge', () => {
    let ids: Record<string, string> = {};
    const r = fixture((commit) => {
      // The ops change whose end-to-end decides the later merges (logic.sh e2e_commit).
      ids = { old: commit('green-older', true, 'ops/x'), green: commit('green', true), red: commit('red', true), pending: commit('pending', true), tip: commit('board', false) };
      return {
        tip: ids['tip']!,
        checks: {
          [ids['old']!]: ok, [ids['green']!]: ok, [ids['tip']!]: ok,
          [ids['red']!]: [{ name: 'check', conclusion: 'success' }, { name: 'e2e', conclusion: 'failure' }],
          [ids['pending']!]: [{ name: 'check', conclusion: 'success' }, { name: 'e2e', status: 'in_progress', conclusion: null }],
        },
      };
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Skipped ${ids['tip']!.slice(0, 12)}: not signed by GitHub`);
    expect(r.stdout).toContain(`Skipped ${ids['pending']!.slice(0, 12)}: checks still running (e2e still running).`);
    expect(r.stdout).toContain(`Skipped ${ids['red']!.slice(0, 12)}: a check failed (e2e failed).`);
    expect(r.stdout).toContain(`Tag deploy -> ${ids['green']!.slice(0, 12)}.`);
    expect(r.calls).toContain(`api -X POST repos/o/r/git/refs -f ref=refs/tags/deploy -f sha=${ids['green']}`);
    expect(r.stdout).not.toContain(ids['old']!.slice(0, 12));
  }, 60_000);

  it('refuses green-looking merges the gate does not cover: a red ops end-to-end earlier, a lone other run, an all-skipped set (OPS-GATE)', () => {
    let ids: Record<string, string> = {};
    const r = fixture((commit) => {
      ids = {
        // The ops change's end-to-end failed (669de71 on 2026-10-04): later merges that leave ops alone run none.
        ops: commit('ops-red', true, 'ops/x'),
        app: commit('app', true),
        lone: commit('lone', true),
        skipped: commit('skipped', true),
        other: commit('other-app', true),
      };
      return {
        tip: ids['other']!,
        checks: {
          [ids['ops']!]: [{ name: 'check', conclusion: 'success' }, { name: 'e2e', conclusion: 'failure' }],
          [ids['app']!]: [{ name: 'check', conclusion: 'success' }],
          [ids['lone']!]: [{ name: 'historical-data', conclusion: 'success' }],
          [ids['skipped']!]: [{ name: 'check', conclusion: 'skipped' }, { name: 'historical-data', conclusion: 'skipped' }],
          [ids['other']!]: [{ name: 'check', conclusion: 'success', app: 'some-bot' }],
        },
      };
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(`Skipped ${ids['other']!.slice(0, 12)}: no check runs reported (no check run from GitHub Actions).`);
    expect(r.stdout).toContain(`Skipped ${ids['skipped']!.slice(0, 12)}: a check failed (check was skipped, not success).`);
    expect(r.stdout).toContain(`Skipped ${ids['lone']!.slice(0, 12)}: no check runs reported (no check run from GitHub Actions).`);
    expect(r.stdout).toContain(`Skipped ${ids['app']!.slice(0, 12)}: a check failed (the ops end-to-end of ${ids['ops']!.slice(0, 12)}: e2e failed).`);
    expect(r.stderr).toContain('Not deployable');
    expect(r.calls).not.toContain('refs/tags/deploy -f sha=');
  }, 60_000);
});

describe('workers.dev subdomain (ops/deploy/cf-subdomain.sh) against a fake Cloudflare API', () => {
  type Reply = { status: number; body: unknown };
  async function run(getReply: Reply) {
    const calls: { method: string; auth: string }[] = [];
    const server = createServer((req, res) => {
      calls.push({ method: req.method ?? '', auth: req.headers['authorization'] ?? '' });
      const r: Reply = req.method === 'GET' ? getReply : { status: 200, body: { success: true, result: { subdomain: 'x' } } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const child = spawn('bash', [join(root, 'ops/deploy/cf-subdomain.sh')], {
      env: { PATH: process.env['PATH'] ?? '', CLOUDFLARE_API_TOKEN: 'TESTcf', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_URL: `http://127.0.0.1:${port}/client/v4` },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const status = await new Promise<number | null>((r) => child.on('close', r));
    server.close();
    return { status, out, err, calls };
  }

  it('keeps an existing subdomain and never sends a PUT', async () => {
    const r = await run({ status: 200, body: { success: true, result: { subdomain: 'owners-pick' } } });
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe('owners-pick');
    expect(r.calls.map((c) => c.method)).toEqual(['GET']);
    expect(r.calls[0]?.auth).toBe('Bearer TESTcf');
  });

  it('stops on a server error, a rate limit or a refused token, without a PUT', async () => {
    for (const [status, msg] of [
      [500, 'Could not read the workers.dev subdomain (HTTP 500'],
      [429, 'Could not read the workers.dev subdomain (HTTP 429'],
      [403, 'needs Account > Workers Scripts > Edit'],
    ] as const) {
      const r = await run({ status, body: { success: false, errors: [{ code: 1, message: 'nope' }] } });
      expect(r.status, String(status)).not.toBe(0);
      expect(r.err).toContain(msg);
      expect(r.calls.map((c) => c.method)).toEqual(['GET']);
    }
  });

  it('registers one only when Cloudflare says there is none (error 10007, or an empty result)', async () => {
    for (const reply of [
      { status: 404, body: { success: false, errors: [{ code: 10007, message: 'This account does not have a workers.dev subdomain' }] } },
      { status: 200, body: { success: true, result: { subdomain: null } } },
    ]) {
      const r = await run(reply);
      expect(r.status).toBe(0);
      expect(r.out.trim()).toMatch(/^zeroed-[0-9a-f]{8}$/);
      expect(r.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    }
    // A 404 for another reason is not "none".
    const other = await run({ status: 404, body: { success: false, errors: [{ code: 7003, message: 'Could not route' }] } });
    expect(other.status).not.toBe(0);
    expect(other.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('daily summary deploy step (OPS-SUMMARY, ops/deploy/reports.sh)', () => {
  /** The workflow step's env block, as name -> source expression. */
  const stepEnv = (name: string): Record<string, string> => {
    const wf = read('.github/workflows/deploy.yml').split('\n');
    const start = wf.findIndex((l) => l.trim() === `- name: ${name}`);
    expect(start, name).toBeGreaterThan(0);
    const env: Record<string, string> = {};
    let inEnv = false;
    for (const l of wf.slice(start + 1)) {
      if (/^\s{6}- /.test(l)) break;
      if (/^\s{8}env:\s*$/.test(l)) inEnv = true;
      else if (/^\s{8}\S/.test(l)) inEnv = false;
      else if (inEnv) {
        const m = /^\s{10}([A-Z_]+): (.*)$/.exec(l);
        if (m) env[m[1]!] = m[2]!;
      }
    }
    return env;
  };

  it('runs only after the tag step and the tooling succeeded', () => {
    const wf = read('.github/workflows/deploy.yml');
    const step = wf.slice(wf.indexOf('- name: Set up the daily summary'));
    expect(/^\s+if: (.*)$/m.exec(step)?.[1]).toBe("${{ !cancelled() && steps.tag.outcome == 'success' && steps.tooling.outcome == 'success' }}");
    expect(wf).toMatch(/- name: Move the deploy tag\n\s+id: tag\n/);
    expect(wf).toMatch(/- name: Install the locked watchdog tooling[^\n]*\n\s+id: tooling\n/);
  });

  it('the step gets exactly these secrets and the DATA_REPO variable, and DATA_STORE_TOKEN reaches no other step', () => {
    const env = stepEnv('Set up the daily summary');
    const secrets = Object.values(env).flatMap((v) => [...v.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])).sort();
    expect(secrets).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'DATA_STORE_TOKEN']);
    expect(env['DATA_REPO']).toBe('${{ vars.DATA_REPO }}');
    const wf = read('.github/workflows/deploy.yml');
    expect(wf.match(/secrets\.DATA_STORE_TOKEN/g)).toHaveLength(1);
    expect(wf).toContain('run: bash ops/deploy/reports.sh');
    // The script names no other secret to set, and never the heartbeat key.
    const s = read('ops/deploy/reports.sh').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect([...s.matchAll(/secret put (\S+)/g)].map((m) => m[1])).toEqual(['REPORTS_TOKEN']);
    expect(s).not.toMatch(/HEARTBEAT_HMAC_KEY|TELEGRAM|DEPLOY_CODE|secret (delete|bulk|list)|--secrets-file/);
  });

  /**
   * reports.sh against a fake Cloudflare API, a stand-in wrangler and a small repository whose deploy tag is one commit
   * behind its tip: the stand-in logs which wrangler.toml it got (the tagged commit's says "tagged").
   */
  async function deploy(env: Record<string, string>, o: { tag?: boolean } = {}) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { subdomain: 'owners-pick' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), 'zeroed-reports-'));
    const repo = join(dir, 'repo');
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
    mkdirSync(join(repo, 'packages/ops'), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'packages/ops/wrangler.toml'), 'tagged\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'tagged');
    if (o.tag !== false) git('tag', 'deploy');
    writeFileSync(join(repo, 'packages/ops/wrangler.toml'), 'tip\n');
    git('commit', '-q', '-am', 'tip');
    const log = join(dir, 'calls.log');
    // A stand-in wrangler: records the config's content, the other arguments and what it read on stdin.
    writeFileSync(join(dir, 'wrangler'), `#!/usr/bin/env bash\nset -euo pipefail\n[ "$1" = --config ] || exit 9\ncfg="$(cat "$2")"\nshift 2\nin=""\nif [ "\${1:-}" = secret ]; then in="$(cat)"; fi\nprintf 'CONFIG %s ARGS %s | STDIN %s\\n' "$cfg" "$*" "$in" >> "${log}"\nif [ "\${1:-}" = deploy ]; then echo "Deployed https://zeroed-watchdog.owners-pick.workers.dev"; fi\n`);
    chmodSync(join(dir, 'wrangler'), 0o755);
    const child = spawn('bash', [join(root, 'ops/deploy/reports.sh')], {
      env: { PATH: process.env['PATH'] ?? '', CLOUDFLARE_API_URL: `http://127.0.0.1:${port}/client/v4`, WRANGLER: join(dir, 'wrangler'), GITHUB_REPOSITORY: 'macdarenz-droid/Meme-snipe', REPO_ROOT: repo, SKIP_TAG_FETCH: '1', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const status = await new Promise<number | null>((r) => child.on('close', r));
    server.close();
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const worktrees = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n').length;
    rmSync(dir, { recursive: true, force: true });
    return { status, out, calls, worktrees };
  }
  const TOKEN = 'github_pat_TESTtoken0123456789abcdefghij';
  const FULL = { CLOUDFLARE_API_TOKEN: 'TESTcf', CLOUDFLARE_ACCOUNT_ID: 'acc', DATA_STORE_TOKEN: TOKEN, DATA_REPO: 'macdarenz-droid/zeroed-data' };

  it('deploys the code with DATA_REPO and sets only REPORTS_TOKEN, the token on stdin and in no output', async () => {
    const r = await deploy(FULL);
    expect(r.status).toBe(0);
    // From the deploy tag's commit, not the tip; the temporary worktree is removed afterwards.
    expect(r.calls).toEqual([
      'CONFIG tagged ARGS deploy --var DATA_REPO:macdarenz-droid/zeroed-data | STDIN ',
      `CONFIG tagged ARGS secret put REPORTS_TOKEN | STDIN ${TOKEN}`,
    ]);
    expect(r.worktrees).toBe(1);
    expect(r.calls.filter((c) => c.split(' | STDIN')[0]!.includes(TOKEN))).toEqual([]);
    expect(r.out).not.toContain(TOKEN);
    expect(r.out).toContain('Its other secrets are unchanged.');
  });

  it('changes nothing without the Cloudflare token or DATA_STORE_TOKEN', async () => {
    for (const drop of ['CLOUDFLARE_API_TOKEN', 'DATA_STORE_TOKEN']) {
      const env: Record<string, string> = { ...FULL };
      delete env[drop];
      const r = await deploy(env);
      expect(r.status, drop).toBe(0);
      expect(r.calls, drop).toEqual([]);
      expect(r.out).toContain('the daily summary is not set up');
    }
  });

  it('refuses a token that is not a GitHub token, and deploys nothing without a deploy tag', async () => {
    for (const bad of ['has space 0123456789abcdefghij', 'short_tok', 'github_pat_ok0123456789abcdef;rm -rf /']) {
      const r = await deploy({ ...FULL, DATA_STORE_TOKEN: bad });
      expect(r.status, bad).not.toBe(0);
      expect(r.calls, bad).toEqual([]);
      expect(r.out).toContain('DATA_STORE_TOKEN has characters a GitHub token does not have.');
      expect(r.out).not.toContain(bad);
    }
    const none = await deploy(FULL, { tag: false });
    expect(none.status).not.toBe(0);
    expect(none.calls).toEqual([]);
    expect(none.out).toContain('No deploy tag');
  });

  it('refuses this public repository (any case), a missing or malformed DATA_REPO, before any call', async () => {
    for (const repo of ['macdarenz-droid/Meme-snipe', 'MACDARENZ-DROID/MEME-SNIPE', '', 'https://github.com/x/y', 'zeroed-data']) {
      const r = await deploy({ ...FULL, DATA_REPO: repo });
      expect(r.status, repo).not.toBe(0);
      expect(r.calls, repo).toEqual([]);
      expect(r.out).not.toContain(TOKEN);
    }
  });
});

describe('PATHS-FIX: the engine folders, the pull account and its chroot', () => {
  const main = read('ops/host/install-main.sh');
  const worker = read('ops/host/files/etc/systemd/system/zeroed-worker.service');

  it('the installer makes each folder with its owner, group and mode, and the worker unit may write exactly those', () => {
    for (const line of [
      'install -d -m 2750 -o zeroed-worker -g zeroed-pull /var/lib/zeroed-md',
      'install -d -m 2770 -o zeroed-worker -g zeroed-pull /var/lib/zeroed-md/receipts',
      'install -d -m 2730 -o zeroed-worker -g zeroed-spool /var/lib/zeroed-spool',
      'install -d -m 2770 -o zeroed-worker -g zeroed-sentinel /var/lib/zeroed-usage',
      'install -d -m 0755 -o root -g root /srv/zeroed_pull /etc/zeroed/pull-keys',
      // Never chmod the read-only bind while it is mounted (an update would stop on EROFS).
      'mountpoint -q /srv/zeroed_pull/md || install -d -m 0755 -o root -g root /srv/zeroed_pull/md',
    ]) expect(main.split('\n'), line).toContain(line);
    expect(worker).toMatch(/^ReadWritePaths=\/var\/lib\/zeroed-md \/var\/lib\/zeroed-spool \/var\/lib\/zeroed-usage$/m);
    expect(worker).toMatch(/^SupplementaryGroups=zeroed-pull zeroed-spool$/m);
    expect(worker.split('\n').filter((l) => !l.startsWith('#')).join('\n')).not.toContain('botops');
    expect(worker).toMatch(/^StateDirectoryMode=0700$/m);
    // The groups exist before any unit names them.
    expect(main.indexOf('groupadd --system zeroed-pull')).toBeLessThan(main.indexOf('# @@FILES@@'));
    expect(main.indexOf('groupadd --system zeroed-spool')).toBeLessThan(main.indexOf('# @@FILES@@'));
    expect(main.indexOf('groupadd --system zeroed-sentinel')).toBeLessThan(main.indexOf('# @@FILES@@'));
    expect(main).toContain('useradd --system --gid zeroed-pull --no-create-home --home-dir / --shell /usr/sbin/nologin zeroed-pull');
  });

  it('md is bound read-only and receipts read-write into the chroot, both before SSH', () => {
    const md = read('ops/host/files/etc/systemd/system/srv-zeroed_pull-md.mount');
    const rc = read('ops/host/files/etc/systemd/system/srv-zeroed_pull-md-receipts.mount');
    expect(md).toMatch(/^What=\/var\/lib\/zeroed-md$/m);
    expect(md).toMatch(/^Where=\/srv\/zeroed_pull\/md$/m);
    expect(md).toMatch(/^Options=bind,ro,/m);
    expect(rc).toMatch(/^What=\/var\/lib\/zeroed-md\/receipts$/m);
    expect(rc).toMatch(/^Where=\/srv\/zeroed_pull\/md\/receipts$/m);
    expect(rc).toMatch(/^Options=bind,rw,/m);
    for (const u of [md, rc]) expect(u).toMatch(/^Before=ssh\.service ssh\.socket$/m);
    expect(main).toContain('systemctl enable --now zeroed-receipts-fs.service srv-zeroed_pull-md.mount srv-zeroed_pull-md-receipts.mount');
    // Ruling 20: receipts/ is its own small filesystem, mounted before both binds and SSH.
    const fsu = read('ops/host/files/etc/systemd/system/zeroed-receipts-fs.service');
    expect(fsu).toMatch(/^Before=srv-zeroed_pull-md\.mount srv-zeroed_pull-md-receipts\.mount ssh\.service ssh\.socket$/m);
    expect(fsu).toMatch(/^ExecStart=\/usr\/local\/lib\/zeroed\/receipts-fs start$/m);
    expect(rc).toMatch(/^Requires=srv-zeroed_pull-md\.mount zeroed-receipts-fs\.service$/m);
    expect(md).toMatch(/^After=zeroed-receipts-fs\.service$/m);
    const script = read('ops/host/files/usr/local/lib/zeroed/receipts-fs');
    expect(script).toContain('fallocate -l "$SIZE" "$IMG.new"');
    expect(script).not.toContain('truncate');
    // nodiscard: mkfs would otherwise free the preallocated blocks again (measured: 131,072 -> 8,960 512-byte blocks).
    expect(script).toContain('mkfs.ext4 -q -F -E nodiscard -b 1024 -I 256 -N "$INODES" -m 0 -L zreceipts "$IMG.new"');
    expect(script).toContain('mount -o loop,nodev,nosuid,noexec "$IMG" "$MNT"');
    expect(script).toMatch(/^IMG_DIR=\/var\/lib\/zeroed-receipts$/m);
    // mkfs.ext4 and e2fsck come from e2fsprogs, installed like every other tool the host scripts use.
    expect(main).toMatch(/^PACKAGES=\(.*\be2fsprogs\b.*\)$/m);
  });

  it('the pull account is sftp only, chrooted, with no key until the operator adds one, and its Match block ends', () => {
    const conf = read('ops/host/files/etc/ssh/sshd_config.d/20-zeroed-pull.conf');
    const lines = conf.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual(['Match User zeroed-pull', 'ChrootDirectory /srv/zeroed_pull', 'ForceCommand internal-sftp -u 0027',
      'AuthorizedKeysFile /etc/zeroed/pull-keys/%u', 'AllowTcpForwarding no', 'AllowAgentForwarding no', 'AllowStreamLocalForwarding no',
      'PermitTunnel no', 'X11Forwarding no', 'PermitTTY no', 'Match all']);
    expect(walk('ops/host/files/etc/zeroed').filter((p) => p.includes('pull-keys'))).toEqual([]);
    expect(main).toContain('/usr/sbin/sshd -t || die "sshd refuses the SSH settings"');
  });
});

describe('PATHS-FIX ruling 24: the provider usage ledger is in every backup', () => {
  // The real zeroed-backup and zeroed-restore-drill, with a stand-in `age` that copies (encryption is tested by the ops
  // end-to-end with the real tool); sqlite3 and tar are the real ones.
  const bin = mkdtempSync(join(tmpdir(), 'zeroed-bk-bin-'));
  writeFileSync(join(bin, 'age'), '#!/usr/bin/env bash\nout=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -R|-r|-i) shift 2 ;; -d) shift ;; *) in="$1"; shift ;; esac; done\nif [ -n "$out" ]; then cat "${in:-/dev/stdin}" > "$out"; else cat "${in:-/dev/stdin}"; fi\n');
  chmodSync(join(bin, 'age'), 0o755);
  const run = (script: string, args: string[], env: Record<string, string>) =>
    spawnSync('bash', [join(root, script), ...args], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, ...env } });

  it('a bundle holds zeroed-usage/rpc-usage.db and the restore drill restores and checks it', () => {
    // Ruling 28: the scripts need the sqlite3 CLI, so this test needs it too and never skips without it. CI's check job
    // runs on ubuntu-latest (Ubuntu 24.04 until Nov 2026), whose image lists "sqlite3 3.45.1" under Databases
    // (actions/runner-images, images/ubuntu/Ubuntu2404-Readme.md); the host installs it (install-main.sh PACKAGES).
    const cli = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
    if (cli.status !== 0) throw new Error('sqlite3 missing: install the sqlite3 command-line tool (apt-get install sqlite3); zeroed-backup and zeroed-restore-drill need it');
    const t = mkdtempSync(join(tmpdir(), 'zeroed-bk-'));
    const src = join(t, 'zeroed');
    const usage = join(t, 'zeroed-usage');
    const out = join(t, 'backups');
    mkdirSync(src);
    mkdirSync(usage);
    const db = (p: string, table: string) => spawnSync('sqlite3', [p, `PRAGMA journal_mode=WAL; CREATE TABLE ${table}(x); INSERT INTO ${table} VALUES (1);`], { encoding: 'utf8' });
    expect(db(join(src, 'bot.db'), 'ledger').status).toBe(0);
    expect(db(join(usage, 'rpc-usage.db'), 'reservations').status).toBe(0);
    writeFileSync(join(t, 'recipients'), 'age1test\n');
    const env = { ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_USAGE_SRC: usage, ZEROED_BACKUP_OUT: out, ZEROED_BACKUP_RECIPIENTS: join(t, 'recipients') };
    const bk = run('ops/host/files/usr/local/sbin/zeroed-backup', [], env);
    expect(bk.status, bk.stderr + bk.stdout).toBe(0);
    expect(bk.stdout).toMatch(/: 2 file\(s\), 1 recipient\(s\)\.$/m);
    const file = join(out, readdirSync(out)[0]!);
    const listing = spawnSync('tar', ['-tf', file], { encoding: 'utf8' }).stdout.split('\n');
    expect(listing).toContain('./zeroed-usage/rpc-usage.db');
    expect(listing).toContain('./bot.db');
    const drill = run('ops/host/files/usr/local/sbin/zeroed-restore-drill', [join(t, 'identity')], env);
    expect(drill.status, drill.stdout).toBe(0);
    expect(drill.stdout).toContain('zeroed-usage/rpc-usage.db reservations: 1 rows');
    expect(drill.stdout).toMatch(/^PASS: .*, 2 file\(s\) restored/m);
    // The drill compares against the live usage ledger: a different live schema fails it.
    expect(spawnSync('sqlite3', [join(usage, 'rpc-usage.db'), 'CREATE TABLE extra(y);']).status).toBe(0);
    const bad = run('ops/host/files/usr/local/sbin/zeroed-restore-drill', [join(t, 'identity')], env);
    expect(bad.stdout).toContain('FAIL: zeroed-usage/rpc-usage.db tables differ from the live database');
    rmSync(t, { recursive: true, force: true });
  });

  it('the backup unit may read the usage folder', () => {
    expect(read('ops/host/files/etc/systemd/system/zeroed-backup.service')).toMatch(/^ReadWritePaths=\/var\/backups\/zeroed \/var\/lib\/zeroed \/var\/lib\/zeroed-usage$/m);
  });
});
